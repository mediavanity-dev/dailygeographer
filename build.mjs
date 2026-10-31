// Builds site/data/YYYY-MM-DD.json for today's country (and tomorrow's, late in the UTC day).
// Run by GitHub Actions; needs Node 20+ (built-in fetch). No dependencies.
import { createHash } from 'node:crypto';
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
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

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

// GDELT tags outlets with FIPS 10-4 codes, taken from Wikidata; these fill its gaps. An empty list means GDELT has no code.
const FIPS = { NL: ['NL'], PS: ['WE', 'GZ'], SJ: ['SV', 'JN'], BQ: [] };

async function getFips(list) {
  const rows = await sparql(`SELECT ?c ?f WHERE { VALUES ?c { ${list.map((x) => `wd:${x.qid}`).join(' ')} } ?c wdt:P901 ?f }`);
  const byQid = {};
  for (const r of rows) (byQid[r.c.value.split('/').pop()] ??= []).push(r.f.value);
  return (x) => FIPS[x.code] ?? byQid[x.qid]?.sort() ?? [];
}

// Google News country editions, tried in English and then each official language. Google silently redirects a
// missing edition to another country's (usually the US), so only editions it serves under the same country code are kept.
const GOOGLE_LANG = { es: ['es-419', 'es'], pt: ['pt-419', 'pt-PT', 'pt-BR'], zh: ['zh-Hans', 'zh-Hant'] };
const EXTRA_LANG = { CN: ['zh-Hans'], TW: ['zh-Hant'], HK: ['zh-Hant'], MO: ['zh-Hant'] }; // Wikidata gives no ISO 639-1 code here

async function getGoogleEditions(list) {
  const rows = await sparql(`SELECT ?c ?l WHERE { VALUES ?c { ${list.map((x) => `wd:${x.qid}`).join(' ')} } ?c wdt:P37/wdt:P218 ?l }`);
  const langs = {};
  for (const r of rows) (langs[r.c.value.split('/').pop()] ??= []).push(r.l.value);
  const editions = {};
  for (const x of list) {
    for (const lang of [...new Set(['en', ...(EXTRA_LANG[x.code] ?? []), ...(langs[x.qid] ?? []).sort().flatMap((l) => GOOGLE_LANG[l] ?? [l])])]) {
      const hl = lang === 'en' ? `en-${x.code}` : lang;
      try {
        const res = await fetch(`https://news.google.com/rss?hl=${hl}&gl=${x.code}&ceid=${x.code}:${lang}`, { headers: UA, signal: AbortSignal.timeout(20000) });
        await res.body?.cancel();
        // Keep the edition Google lands on: asking for Peru in Aymara serves its Spanish edition, PE:es-419.
        const final = new URL(res.url).searchParams;
        if (res.ok && final.get('gl') === x.code) { editions[x.code] = final.get('ceid'); break; }
      } catch (err) {
        console.warn('Google News probe failed:', x.code, lang, err.message);
      }
    }
  }
  return (x) => editions[x.code];
}

// Each place's history comes from the lead of its Wikipedia "History of …" article, found by trying the usual titles.
// Places without one use the History section of their main article ("Aruba#History").
const HISTORY = { SH: 'History of Saint Helena', SJ: 'History of Svalbard' };

async function getHistoryTitles(list) {
  const candidates = (x) => [...new Set([x.title.replace(/_/g, ' '), x.name].flatMap((t) => [`History of ${t}`, `History of the ${t}`]))];
  const resolved = new Map();
  for (const batch of chunks([...new Set(list.flatMap(candidates))], 50)) {
    const { query } = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageprops&ppprop=disambiguation&titles=${encodeURIComponent(batch.join('|'))}`);
    const step = new Map([...(query.normalized ?? []), ...(query.redirects ?? [])].map((r) => [r.from, r]));
    const ok = new Set(query.pages.filter((p) => !p.missing && !p.pageprops?.disambiguation).map((p) => p.title));
    for (const t of batch) {
      let to = t, hop;
      while ((hop = step.get(to)) && hop.to !== to) to = hop.to;
      if (ok.has(to) && to.startsWith('History')) resolved.set(t, to);
    }
  }
  return (x) => HISTORY[x.code] ?? candidates(x).map((t) => resolved.get(t)).find(Boolean) ?? `${x.title.replace(/_/g, ' ')}#History`;
}

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
  const [fips, history, google] = [await getFips(list), await getHistoryTitles(list), await getGoogleEditions(list)];
  for (const x of list) Object.assign(x, { fips: fips(x), history: history(x), google: google(x) });
  await writeFile(COUNTRIES_FILE, JSON.stringify(list, null, 2) + '\n');
  console.log(`Wrote countries.json: ${list.length} countries and territories (${list.filter((x) => x.status === 'UN member state').length} UN members)`);
  console.log('No GDELT code:', list.filter((x) => !x.fips.length).map((x) => x.name).join(', ') || 'none');
  console.log(`Google News editions: ${list.filter((x) => x.google).length}`);
  console.log('History from a section:', list.filter((x) => x.history.includes('#')).map((x) => x.name).join(', ') || 'none');
}

// rotation.json records who has appeared this cycle, so every place gets one day per cycle even when the list changes:
// new entries join the current cycle and removed ones simply drop out.
const ROTATION_FILE = new URL('./rotation.json', import.meta.url);

async function pickCountry(date, previousQid) {
  const members = JSON.parse(await readFile(COUNTRIES_FILE, 'utf8'));
  // A day that already has a file keeps its country, so list changes never switch a country mid-day.
  let pick = members.find((m) => m.qid === previousQid);
  if (!pick) {
    const rotation = (await readExisting(ROTATION_FILE)) ?? { cycle: 1, shown: [] };
    let left = members.filter((m) => !rotation.shown.includes(m.qid));
    if (!left.length) [rotation.cycle, rotation.shown, left] = [rotation.cycle + 1, [], members];
    // Each cycle gets its own fixed shuffle, derived from the cycle number.
    const rank = (m) => createHash('sha256').update(`${rotation.cycle}:${m.qid}`).digest('hex');
    pick = left.sort((a, b) => rank(a).localeCompare(rank(b)))[0];
    rotation.shown.push(pick.qid);
    await writeFile(ROTATION_FILE, JSON.stringify(rotation, null, 2) + '\n');
  }
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

// "History of X" gives that article's lead; "X#History" gives the opening paragraphs of the section (headings dropped).
async function getHistory(ref) {
  if (!ref) return null;
  const [title, section] = ref.split('#');
  try {
    const { query } = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=extracts&explaintext=1&exsectionformat=wiki${section ? '' : '&exintro=1'}&titles=${encodeURIComponent(title)}`);
    const page = query.pages[0];
    let text = page.extract ?? '';
    if (section) {
      const m = text.match(new RegExp(`^== ${section} ==$([\\s\\S]*?)(?=^== [^=]|(?![\\s\\S]))`, 'm'));
      text = m ? m[1].replace(/^=+ .* =+$/gm, '') : '';
    }
    const paragraphs = text.split('\n').map((p) => p.trim()).filter(Boolean).slice(0, section ? 4 : undefined);
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}${section ? `#${section}` : ''}`;
    return paragraphs.length ? { title: section ? `${page.title}: ${section}` : page.title, paragraphs, url } : null;
  } catch (err) {
    console.warn('Wikipedia history failed:', err.message);
    return null;
  }
}

// Headlines come in two lists, local outlets and international coverage, so neither view replaces the other.
// GDELT allows roughly one request per 5 seconds, so attempts are spaced out.
const NEWS_PER_LIST = 8, PER_SOURCE = 2;

// GDELT dates look like 20261031T120000Z.
const ageDays = (s) => (Date.now() - Date.parse(s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))) / 86400000;
const ageLabel = (items) => {
  const oldest = Math.max(...items.map((x) => ageDays(x.date)));
  return oldest <= 1 ? 'Last 24 hours' : oldest <= 7 ? 'Last 7 days' : oldest <= 31 ? 'Last month' : 'Last 3 months';
};

// One query per list, newest first, keeps GDELT calls (and its rate limiting) to a minimum.
async function newest(q, span, exclude = new Set()) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=75&sort=datedesc&timespan=${span}`;
  try {
    // GDELT often answers HTTP 429 to shared CI addresses, so the query is retried with long waits (20s, 40s, 60s).
    const { articles = [] } = await getJSON(url, 4, 20000);
    const seen = new Set(), perSource = {};
    // A cap per outlet keeps one prolific site from filling the list.
    const items = articles
      .filter((x) => x.title && !exclude.has(x.url) && !seen.has(x.title) && seen.add(x.title)
        && (perSource[x.domain] = (perSource[x.domain] ?? 0) + 1) <= PER_SOURCE)
      .slice(0, NEWS_PER_LIST)
      .map((x) => ({ title: cleanTitle(x.title), url: x.url, source: x.domain, date: x.seendate, lang: x.language }));
    return items.length ? { label: ageLabel(items), items } : null;
  } catch (err) {
    console.warn('GDELT query failed:', q, err.message);
    return null;
  } finally {
    await sleep(6000);
  }
}

async function getNews(c) {
  const fips = c.fips ?? [];
  const local = fips.length > 1 ? `(${fips.map((f) => `sourcecountry:${f}`).join(' OR ')})` : `sourcecountry:${fips[0]}`;
  const localNews = fips.length ? await newest(local, '3months') : undefined;
  const notLocal = fips.map((f) => ` -sourcecountry:${f}`).join('');
  const intlNews = await newest(`"${c.name}" sourcelang:english${notLocal}`, '7d', new Set(localNews?.items.map((x) => x.url)));
  // undefined: no source covers this place; null: nothing found this time.
  return { local: localNews, international: intlNews, google: c.google ? await getGoogleNews(c.google) : undefined };
}

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Top stories of the place's Google News edition (e.g. "GH:en"). Google's ranking picks these, so they are shown apart.
async function getGoogleNews(edition) {
  const [gl, lang] = edition.split(':');
  try {
    const hl = lang === 'en' ? `en-${gl}` : lang;
    const res = await fetch(`https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${edition}`, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok || new URL(res.url).searchParams.get('gl') !== gl) throw new Error(`HTTP ${res.status} ${res.url}`);
    const xml = await res.text(), perSource = {};
    const language = new Intl.DisplayNames(['en'], { type: 'language' }).of(lang); // matches GDELT's "English", "Spanish", …
    const tag = (item, t) => decode(item.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? '');
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
      const source = tag(item, 'source'), host = item.match(/<source url="https?:\/\/(?:www\.)?([^/"]+)/)?.[1];
      // Titles end with " - Source"; the source is shown separately.
      const title = tag(item, 'title').replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
      return { title, url: tag(item, 'link'), source: host ?? source, date: new Date(tag(item, 'pubDate')).toISOString(), lang: language };
    }).filter((x) => (perSource[x.source] = (perSource[x.source] ?? 0) + 1) <= PER_SOURCE).slice(0, NEWS_PER_LIST);
    return items.length ? { label: `Top stories, Google News ${edition} edition`, items } : null;
  } catch (err) {
    console.warn('Google News failed:', edition, err.message);
    return null;
  }
}

async function readExisting(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function build(date) {
  const file = new URL(`${isoDate(date)}.json`, DATA_DIR);
  const previous = await readExisting(file);
  const c = await pickCountry(date, previous?.qid);
  const name = c.name;
  const fresh = await getNews(c);
  // Keep earlier headlines for a list that came back empty this time.
  const news = {
    local: fresh.local === undefined ? null : fresh.local ?? previous?.news?.local ?? { label: 'No recent headlines found', items: [] },
    international: fresh.international ?? previous?.news?.international ?? { label: 'No recent headlines found', items: [] },
    google: fresh.google === undefined ? undefined : fresh.google ?? previous?.news?.google ?? { label: 'No recent headlines found', items: [] },
  };
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
    history: await getHistory(c.history),
    news,
  };
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
  const count = (l) => (l ? `${l.items.length} (${l.label})` : 'n/a');
  console.log(`Wrote ${isoDate(date)}.json: ${data.name}; local ${count(news.local)}, international ${count(news.international)}, Google ${count(news.google)}`);
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
