#!/usr/bin/env node
// Save every finished Triton tournament festival as a static file for the past-festival pages and the all-time view.
// Past festivals don't change, so this runs by hand (again only to add a festival that has since ended):
//   node tools/triton-archive.js [--only <festival uuid>] [--force]
//   node tools/triton-archive.js --merge     (only rebuild all.json from the saved files)
// Writes docs/triton/archive/<uuid>.json, docs/triton/archive/index.json and docs/triton/archive/all.json
// (every saved festival merged into one compact file, with the exchange rates of their dates, for the all-time view).
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../docs/triton/triton.js');
const Series = require('../docs/series.js');
// Festivals in docs/series.js still being polled (until two days after they end)
const running = new Set(Series.ofOrg('triton').filter(Series.pollable).map((s) => s.source.festival));

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const force = args.includes('--force');
const mergeOnly = args.includes('--merge');
const DIR = path.join(__dirname, '../docs/triton/archive');
fs.mkdirSync(DIR, { recursive: true });

const fetchFn = (url, o = {}) => fetch(url, { ...o, headers: { 'User-Agent': 'apt-live-tracker (archive)', Accept: 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FESTIVALS = `query ($type: FestivalType, $size: Int!) { series { name festivals(type: $type, size: $size) { uuid name shortName startDate endDate timeZone type } } }`;

// ECB rates (units per USD) for the days around each festival, so the all-time view converts without asking for them
async function ratesFor(festivals) {
  const FX = require('../docs/fx.js').FX;
  const curs = FX.LIST.filter((c) => c !== 'USD' && FX.ECB.has(c));
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const table = {};
  for (const f of festivals) {
    const r = await fetchFn(`https://api.frankfurter.dev/v1/${shift(f.start, -7)}..${shift(f.end, 3)}?base=USD&symbols=${curs.join(',')}`);
    if (!r.ok) throw new Error(`rates for ${f.tag}: HTTP ${r.status}`);
    for (const [d, rates] of Object.entries((await r.json()).rates || {})) table[d] = rates;
    await sleep(200);
  }
  return table;
}

async function writeAll(index) {
  const parts = index.festivals.map((f) => ({ state: JSON.parse(fs.readFileSync(path.join(DIR, f.id + '.json'), 'utf8')), tag: f.tag, start: f.start }));
  const all = T.pack(parts);
  all.index = index.festivals;
  all.fx = await ratesFor(index.festivals);
  const file = path.join(DIR, 'all.json');
  fs.writeFileSync(file, JSON.stringify(all));
  console.log(`all.json: ${Object.keys(all.events).length} events, ${Object.keys(all.ids).length} profiles, ${Object.keys(all.fx).length} days of rates, ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

(async () => {
  if (mergeOnly) return writeAll(JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')));
  const r = await fetchFn(T.API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: FESTIVALS, variables: { type: 'TOURNAMENT', size: 200 } }) });
  const series = (await r.json()).data.series;
  const today = new Date().toISOString().slice(0, 10);
  const all = series.flatMap((s) => s.festivals.map((f) => ({ ...f, series: s.name })))
    .filter((f) => f.endDate < today && !running.has(f.uuid)) // a festival still polled has its own live tracker
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const indexPath = path.join(DIR, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { festivals: [] };
  const byId = new Map(index.festivals.map((f) => [f.id, f]));
  for (const f of all) {
    if (only && f.uuid !== only) continue;
    const file = path.join(DIR, f.uuid + '.json');
    if (fs.existsSync(file) && !force) { console.log('have', f.name); continue; }
    const state = T.emptyState();
    let s;
    for (let attempt = 0; attempt < 3; attempt++) {
      s = await T.pollOnce(state, { festival: f.uuid, fetchFn, concurrency: 2, resultsEvery: 0 });
      // Retry anything that failed (participants or payouts) once more after a pause
      if (!s.errors.length) break;
      console.warn(`  ${s.errors.length} errors, retrying:`, s.errors.slice(0, 2).join(' | '));
      await sleep(5000);
    }
    const out = T.slim(state);
    const ev = Object.values(out.events);
    const entries = ev.reduce((a, e) => a + (e.entries || 0), 0);
    const players = new Set(ev.flatMap((e) => Object.values(e.p).map((p) => p.uid)));
    const missing = ev.reduce((a, e) => a + (e.txMissing || 0), 0);
    const reentries = ev.reduce((a, e) => a + Math.max(0, (e.entries || 0) - Object.keys(e.p).length), 0);
    const paid = Object.values(out.results).reduce((a, x) => a + x.rows.reduce((b, row) => b + row[3], 0), 0);
    fs.writeFileSync(file, JSON.stringify(out));
    byId.set(f.uuid, { id: f.uuid, name: f.name, place: T.festTag(f.name, f.startDate).replace(/ '\d\d$/, ''), tag: T.festTag(f.name, f.startDate),
      series: f.series, one: /Triton One/i.test(f.series), start: f.startDate, end: f.endDate, tz: out.festival.timeZone,
      currency: out.festival.currency, usd: T.usdRate(out.festival.currency, f.startDate),
      events: ev.length, entries, players: players.size, paid, bullets: missing === 0 ? 'all' : missing < reentries ? 'some' : 'none',
      bytes: fs.statSync(file).size });
    console.log(`${f.name}: ${ev.length} events, ${entries} entries, ${players.size} players, paid $${Math.round(paid / 1e6)}M, re-entries unattributed ${missing}, ${Math.round(fs.statSync(file).size / 1024)} KB, ${s.requests} requests`);
    await sleep(1000);
  }
  index.festivals = [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
  index.updatedAt = Math.floor(Date.now() / 1000);
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
  console.log(`index: ${index.festivals.length} festivals`);
  await writeAll(index);
})();
