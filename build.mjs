// Builds site/data/YYYY-MM-DD.json for today's country (and tomorrow's, late in the UTC day).
// Run by GitHub Actions; needs Node 20+ (built-in fetch). No dependencies.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DATA_DIR = new URL('./site/data/', import.meta.url);
const UA = { 'User-Agent': 'dailygeographer.com build (https://dailygeographer.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3, backoff = 5000) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(await res.text());
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`);
      await sleep(backoff * i);
    }
  }
}

// GDELT titles come tokenised ("15 %", "Name . com" suffixes); tidy them for display.
const cleanTitle = (t) => t
  .replace(/\s+[–|-]\s+[^–|-]+\s\.\s[a-z]{2,6}$/i, '')
  .replace(/\s+([,:;!?%])/g, '$1')
  .trim();

const isoDate = (d) => d.toISOString().slice(0, 10);
const dayNumber = (d) => Math.floor(d.getTime() / 86400000);

// Country facts come from Wikidata (CC0, no API key).
const sparql = async (query) =>
  (await getJSON(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`)).results.bindings;

// The rotation list is kept in the repo so Wikidata edits can't reshuffle it; refresh with --refresh-countries.
const COUNTRIES_FILE = new URL('./countries.json', import.meta.url);

// The rotation is every ISO 3166-1 entry with a permanent population, plus Kosovo (XK, used by the EU, IMF and World Bank).
// Wikidata also tags some non-ISO codes with P297; these are dropped.
const NOT_ISO = new Set(['AC', 'CP', 'CQ', 'DG', 'EA', 'EZ', 'TA', 'UN', 'YU']);
const UNINHABITED = new Set(['AQ', 'BV', 'GS', 'HM', 'IO', 'TF', 'UM']); // IO: Chagossians were expelled; no permanent population today
const PREFERRED_ITEM = { DK: 'Q35' }; // Denmark rather than the Danish Realm
const NAMES = { NL: 'Netherlands', IE: 'Ireland', MF: 'Saint Martin', GG: 'Guernsey' };

// Political status shown on the page; UN members not listed here are "UN member state".
const BOT = 'British Overseas Territory', US = 'Unincorporated territory of the United States';
const FR_DEP = 'Overseas department of France', FR_COL = 'Overseas collectivity of France';
const CROWN = 'British Crown Dependency', AU = 'External territory of Australia';
const NL_CC = 'Constituent country of the Kingdom of the Netherlands';
const STATUS = {
  DK: 'UN member state', // membership sits on the Danish Realm item in Wikidata
  PS: 'UN observer state, recognised by most UN members', VA: 'UN observer state',
  TW: 'Partially recognised state; claimed by the People\'s Republic of China',
  XK: 'Partially recognised state; claimed by Serbia',
  EH: 'Non-self-governing territory (UN list); disputed between Morocco and the Sahrawi Republic',
  FK: `${BOT}; claimed by Argentina`, GI: `${BOT}; claimed by Spain`,
  AI: BOT, BM: BOT, KY: BOT, MS: BOT, PN: BOT, SH: BOT, TC: BOT, VG: BOT,
  JE: CROWN, GG: CROWN, IM: CROWN,
  AS: US, GU: US, MP: US, PR: US, VI: US,
  GF: FR_DEP, GP: FR_DEP, MQ: FR_DEP, RE: FR_DEP, YT: FR_DEP,
  BL: FR_COL, MF: FR_COL, PF: FR_COL, PM: FR_COL, WF: FR_COL, NC: 'Special collectivity of France',
  AW: NL_CC, CW: NL_CC, SX: NL_CC, BQ: 'Special municipalities of the Netherlands',
  GL: 'Autonomous territory of Denmark', FO: 'Autonomous territory of Denmark',
  AX: 'Autonomous region of Finland', SJ: 'Part of Norway',
  HK: 'Special administrative region of China', MO: 'Special administrative region of China',
  CK: 'Self-governing in free association with New Zealand', NU: 'Self-governing in free association with New Zealand',
  TK: 'Territory of New Zealand', CX: AU, CC: AU, NF: AU,
};

async function refreshCountries() {
  const rows = await sparql(`SELECT ?c ?code ?article ?un WHERE {
    ?c p:P297 ?s. ?s ps:P297 ?code. FILTER NOT EXISTS { ?s pq:P582 [] } MINUS { ?s wikibase:rank wikibase:DeprecatedRank }
    ?article schema:about ?c; schema:isPartOf <https://en.wikipedia.org/>.
    OPTIONAL { ?c p:P463 ?m. ?m ps:P463 wd:Q1065. FILTER NOT EXISTS { ?m pq:P582 [] } BIND(true AS ?un) }
  }`);
  const byCode = new Map();
  for (const r of rows) {
    const code = r.code.value, qid = r.c.value.split('/').pop(), un = !!r.un;
    if (NOT_ISO.has(code) || UNINHABITED.has(code)) continue;
    const best = byCode.get(code);
    // Several items can share a code (e.g. Cyprus the state and the island): prefer the override, then the UN member.
    if (best && (best.qid === PREFERRED_ITEM[code] || (best.un && qid !== PREFERRED_ITEM[code]))) continue;
    byCode.set(code, { code, qid, title: decodeURIComponent(r.article.value.split('/wiki/')[1]), un });
  }
  const list = [...byCode.values()].map(({ code, qid, title, un }) => {
    const status = STATUS[code] ?? (un ? 'UN member state' : undefined);
    if (!status) throw new Error(`No status for ${code} (${title}); add it to STATUS`);
    // Article titles give the common name ("China", not "People's Republic of China"); drop "(country)" etc.
    const name = NAMES[code] ?? title.replace(/_/g, ' ').replace(/\s*\(.*\)$/, '');
    return { code, qid, title, name, status };
  }).sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(COUNTRIES_FILE, JSON.stringify(list, null, 2) + '\n');
  console.log(`Wrote countries.json: ${list.length} countries and territories (${list.filter((x) => x.status === 'UN member state').length} UN members)`);
}

async function pickCountry(date, previousQid) {
  const members = JSON.parse(await readFile(COUNTRIES_FILE, 'utf8'));
  // Stepping by 37 visits every entry once per cycle in a less predictable order, as long as the count isn't a multiple of 37.
  // A day that already has a file keeps its country, so list changes never switch a country mid-day.
  const pick = members.find((m) => m.qid === previousQid) ?? members[(dayNumber(date) * 37) % members.length];
  console.log(`${members.length} countries and territories; ${isoDate(date)} is ${pick.name}`);
  return { ...pick, ...(await getDetails(pick.qid)) };
}

async function getDetails(qid) {
  const list = (v) => `(GROUP_CONCAT(DISTINCT ?${v}L; separator=", ") AS ?${v})`;
  const [r] = await sparql(`SELECT ?label ${list('official')} ${list('capital')} ${list('continent')} ${list('language')}
      ${list('currency')} ${list('tz')} (MAX(?pop) AS ?population) (MAX(?ar) AS ?area) (SAMPLE(?fl) AS ?flag)
      (SAMPLE(?co) AS ?coord) (SAMPLE(?cc) AS ?calling) WHERE {
    BIND(wd:${qid} AS ?c)
    ?c rdfs:label ?label. FILTER(LANG(?label) = "en")
    OPTIONAL { ?c wdt:P1448 ?officialL. FILTER(LANG(?officialL) = "en") }
    OPTIONAL { ?c wdt:P36 ?cap. ?cap rdfs:label ?capitalL. FILTER(LANG(?capitalL) = "en") }
    OPTIONAL { ?c wdt:P30 ?con. ?con rdfs:label ?continentL. FILTER(LANG(?continentL) = "en") }
    OPTIONAL { ?c wdt:P37 ?lang. ?lang rdfs:label ?languageL. FILTER(LANG(?languageL) = "en") }
    OPTIONAL { ?c wdt:P38 ?cur. ?cur rdfs:label ?currencyL. FILTER(LANG(?currencyL) = "en") }
    OPTIONAL { ?c wdt:P421 ?z. ?z rdfs:label ?tzL. FILTER(LANG(?tzL) = "en") }
    OPTIONAL { ?c wdt:P1082 ?pop } OPTIONAL { ?c wdt:P2046 ?ar } OPTIONAL { ?c wdt:P41 ?fl }
    OPTIONAL { ?c wdt:P625 ?co } OPTIONAL { ?c wdt:P474 ?cc }
  } GROUP BY ?label`);
  const v = (k) => r?.[k]?.value || undefined;
  const [lon, lat] = v('coord')?.match(/-?[\d.]+/g) ?? [];
  return {
    label: v('label'), official: v('official'), capital: v('capital'), continent: v('continent'),
    languages: v('language'), currency: v('currency'), timezones: v('tz'), calling: v('calling'),
    population: v('population') && Number(v('population')), area: v('area') && Number(v('area')),
    flag: v('flag')?.replace(/^http:/, 'https:'), lat, lon,
  };
}

async function getSummary(title) {
  try {
    const s = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    return { extract: s.extract, url: s.content_urls?.desktop?.page };
  } catch (err) {
    console.warn('Wikipedia failed:', err.message);
    return null;
  }
}

// GDELT allows roughly one request per 5 seconds, so attempts are spaced out.
async function getNews(name) {
  const src = name.toLowerCase().replace(/[^a-z]/g, '');
  const attempts = [
    { q: `sourcecountry:${src} sourcelang:english`, span: '1d', label: 'From local outlets, last 24 hours' },
    { q: `sourcecountry:${src}`, span: '1d', label: 'From local outlets, last 24 hours' },
    { q: `sourcecountry:${src}`, span: '7d', label: 'From local outlets, last 7 days' },
    { q: `"${name}" sourcelang:english`, span: '7d', label: 'International coverage, last 7 days' },
    { q: `sourcecountry:${src}`, span: '3months', label: 'From local outlets, last 3 months' },
  ];
  for (const a of attempts) {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(a.q)}&mode=artlist&format=json&maxrecords=15&sort=datedesc&timespan=${a.span}`;
    try {
      const { articles = [] } = await getJSON(url, 3, 15000);
      const seen = new Set();
      const items = articles
        .filter((x) => x.title && !seen.has(x.title) && seen.add(x.title))
        .slice(0, 12)
        .map((x) => ({ title: cleanTitle(x.title), url: x.url, source: x.domain, date: x.seendate, lang: x.language }));
      if (items.length >= 3) return { label: a.label, items };
    } catch (err) {
      console.warn('GDELT attempt failed:', a.q, a.span, err.message);
    }
    await sleep(6000);
  }
  return null;
}

async function readExisting(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function build(date) {
  const file = new URL(`${isoDate(date)}.json`, DATA_DIR);
  const previous = await readExisting(file);
  const c = await pickCountry(date, previous?.qid);
  const name = c.name;
  const news = (await getNews(name)) ?? previous?.news ?? { label: 'No recent headlines found', items: [] };
  const data = {
    date: isoDate(date),
    updated: new Date().toISOString(),
    qid: c.qid,
    name,
    status: c.status,
    officialName: c.official ?? c.label,
    flag: { svg: c.flag, alt: `Flag of ${name}` },
    facts: {
      Capital: c.capital,
      Continent: c.continent,
      Population: c.population?.toLocaleString('en-US'),
      Area: c.area ? `${Math.round(c.area).toLocaleString('en-US')} km²` : undefined,
      Languages: c.languages,
      Currency: c.currency,
      'Time zones': c.timezones,
      'Calling code': c.calling,
    },
    map: c.lat ? `https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lon}#map=5/${c.lat}/${c.lon}` : undefined,
    summary: await getSummary(c.title),
    news,
  };
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${isoDate(date)}.json: ${data.name}, ${news.items.length} headlines (${news.label})`);
}

if (process.argv.includes('--refresh-countries')) {
  await refreshCountries();
  process.exit(0);
}

await mkdir(DATA_DIR, { recursive: true });
const now = new Date();
await build(now);
// From 22:00 UTC, also prepare tomorrow so the page is ready the moment midnight passes.
if (now.getUTCHours() >= 22) await build(new Date(now.getTime() + 86400000));
