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

async function refreshCountries() {
  // Current UN member states (membership statement without an end date) with an English Wikipedia article.
  const rows = await sparql(`SELECT ?c ?article WHERE {
    ?c p:P463 ?m. ?m ps:P463 wd:Q1065. FILTER NOT EXISTS { ?m pq:P582 [] }
    ?c wdt:P31 wd:Q3624078.
    ?article schema:about ?c; schema:isPartOf <https://en.wikipedia.org/>.
  }`);
  const members = [...new Map(rows.map((r) => [r.c.value, r])).values()]
    .map((r) => ({ qid: r.c.value.split('/').pop(), title: decodeURIComponent(r.article.value.split('/wiki/')[1]) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(COUNTRIES_FILE, JSON.stringify(members, null, 2) + '\n');
  console.log(`Wrote countries.json: ${members.length} countries`);
}

async function pickCountry(date) {
  const members = JSON.parse(await readFile(COUNTRIES_FILE, 'utf8'));
  // Stepping by 37 (coprime with 193) visits every country once per cycle, in a less predictable order.
  const pick = members[(dayNumber(date) * 37) % members.length];
  console.log(`${members.length} UN members; today is ${pick.title}`);
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
  const c = await pickCountry(date);
  const previous = await readExisting(file);
  // Article titles give the common name ("China", not "People's Republic of China"); drop "(country)" etc.
  const name = c.title.replace(/_/g, ' ').replace(/\s*\(.*\)$/, '');
  const news = (await getNews(name)) ?? previous?.news ?? { label: 'No recent headlines found', items: [] };
  const data = {
    date: isoDate(date),
    updated: new Date().toISOString(),
    name,
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
