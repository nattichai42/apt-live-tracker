#!/usr/bin/env node
// Save every finished APT series as a static file for the past-series pages (apt/?f=<slug>) and the all-series page.
// Past series don't change, so this runs by hand (again only to add a series that has since ended):
//   node tools/apt-archive.js [--only <series slug>] [--force]
//   node tools/apt-archive.js --from-state <state.json> --only <slug>   (a series we watched live: keep its richer record)
//   node tools/apt-archive.js --series <id in docs/series.js> --from-state <state.json>
//        (what the poller runs when a series it watched ends: no request to the site's past-series list)
//   node tools/apt-archive.js --repack   (rewrite the saved files in the current compact form, no requests)
//   node tools/apt-archive.js --rates    (only rebuild fx.json: exchange rates for every saved series' dates)
// Also writes docs/apt/archive/fx.json, so pages convert these series without asking for hundreds of days of rates.
// Writes docs/apt/archive/<slug>.json and docs/apt/archive/index.json.
//
// What a finished series still serves: every event's entries, buy-in and times, its payouts, and its registration
// list (everyone who registered, once each). Re-entries are only known for series we watched live, so elsewhere a
// player's bullets are a minimum, except in events whose registrations add up to the entries.
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../docs/apt/tracker.js');
const Series = require('../docs/series.js');

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const only = arg('--only'), fromState = arg('--from-state'), seriesId = arg('--series');
const force = args.includes('--force');
const repack = args.includes('--repack');
const ratesOnly = args.includes('--rates');

// Units per USD for each day of each saved series (a week either side): ECB rates (Frankfurter) for KRW, PHP, ..., and
// the daily jsDelivr files for TWD and VND, which the ECB doesn't publish (from 2 March 2024; earlier days use that one)
async function writeRates(series) {
  const FX = require('../docs/fx.js').FX;
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  // Days already saved keep their rates; only missing days are asked for
  const file = path.join(DIR, 'fx.json');
  let table = {}; try { table = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const have = (d, c) => table[d] && table[d][c] > 0;
  const put = (d, c, v) => { if (v > 0) (table[d] || (table[d] = {}))[c] = v; };
  const ecb = FX.LIST.filter((c) => c !== 'USD' && FX.ECB.has(c));
  const days = new Set();
  for (const f of series) {
    let need = false;
    for (let d = shift(f.start, -1); d <= shift(f.end, 3) && d <= today; d = shift(d, 1)) {
      const day = new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay();
      if (day && day < 6 && !ecb.every((c) => have(d, c))) need = true; // the ECB publishes on weekdays
      if (!have(d < '2024-03-02' ? '2024-03-02' : d, 'TWD')) days.add(d < '2024-03-02' ? '2024-03-02' : d);
    }
    if (!need) continue;
    const r = await fetchFn(`https://api.frankfurter.dev/v1/${shift(f.start, -7)}..${shift(f.end, 7)}?base=USD&symbols=${ecb.join(',')}`);
    if (r.ok) for (const [d, x] of Object.entries((await r.json()).rates || {})) for (const [c, v] of Object.entries(x)) put(d, c, v);
    await sleep(150);
  }
  const list = [...days].sort(); let i = 0;
  const work = async () => { while (i < list.length) { const d = list[i++];
    try {
      const r = await fetchFn(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.min.json`);
      if (r.ok) { const u = (await r.json()).usd || {}; put(d, 'TWD', u.twd); put(d, 'VND', u.vnd); }
    } catch {} } };
  await Promise.all([work(), work(), work(), work()]);
  fs.writeFileSync(file, JSON.stringify(table));
  console.log(`fx.json: ${Object.keys(table).length} days (${list.length} asked for), ${Math.round(fs.statSync(file).size / 1024)} KB`);
}
const DIR = path.join(__dirname, '../docs/apt/archive');
fs.mkdirSync(DIR, { recursive: true });

const fetchFn = (url) => fetch(url, { headers: { 'User-Agent': 'apt-live-tracker (archive)', Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tzOf = (name) => Series.tzOf(name, 'Asia/Taipei'); // the venue's time zone from the series name
// "APT Jeju Classic, South Korea 2026" -> place "Jeju Classic", tag "Jeju Classic '26"
function placeOf(name) {
  const yr = (name.match(/\b(20\d\d)\b/) || [])[1] || '';
  let p = name.replace(/^APT\s+/i, '').replace(/\b20\d\d\b/, '').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  if (/^championship$/i.test(p)) p = 'Championship ' + (name.match(/,\s*([^,\d]+)/) || [, ''])[1].trim();
  return { place: p, tag: `${p} '${yr.slice(2)}`, year: yr };
}

// A finished series as a small file: what only live polling needs is dropped, and its payouts are final
function slim(state) {
  const out = { v: 1, series: state.series, archive: true, updatedAt: state.updatedAt, events: {}, results: {}, feed: [] };
  for (const e of Object.values(state.events)) {
    const { seats, regAt, evAt, lastPoll, ...keep } = e;
    out.events[e.kid] = keep;
  }
  for (const [k, r] of Object.entries(state.results || {})) { const { at, ...rest } = r; out.results[k] = { ...rest, final: true }; }
  out.aliases = state.aliases || {};
  A.repair(out); // saved repaired (and stamped), so pages don't repair it on every load
  return A.pack(out);
}

async function archive(league) {
  let state;
  if (fromState) {
    state = JSON.parse(fs.readFileSync(fromState, 'utf8'));
    A.repair(state);
  } else {
    A.configure({ series: league.slug });
    state = A.emptyState();
    // Round 1 lists the events and reads every registration list and payout table; later rounds retry what failed
    for (let round = 1; round <= 5; round++) {
      const s = await A.pollOnce(state, { fetchFn, concurrency: 3, regBatch: 2000, listEvery: 1e9, finalEvery: 1e9 });
      const pending = Object.values(state.events).filter((e) => !e.regDone && e.phase === 'Completed').length;
      if (s.errors.length) console.warn(`  round ${round}: ${s.errors.length} errors (${s.errors.slice(0, 2).join(' | ')})`);
      if (!pending && !s.errors.length) break;
      await sleep(3000);
    }
  }
  const packed = slim(state);
  const file = path.join(DIR, league.slug + '.json');
  fs.writeFileSync(file, JSON.stringify(packed));
  const out = A.unpack(JSON.parse(JSON.stringify(packed)));
  const ev = Object.values(out.events);
  const nums = [...new Set(ev.map((e) => e.num))];
  const flights = ev.filter((e) => !A.isLaterDay(e.name));
  const paid = Object.values(out.results).reduce((a, r) => a + r.rows.reduce((b, row) => b + row[3], 0), 0);
  const { place, tag } = placeOf(league.name);
  const info = { id: league.slug, name: league.name.replace(/\s+/g, ' ').trim(), place, tag, start: league.startDate, end: league.endDate, tz: league.tz || tzOf(league.name),
    currency: league.currency, events: nums.filter((n) => out.results[n] && out.results[n].rows.length).length,
    entries: flights.reduce((a, e) => a + (e.entries || 0), 0), players: A.players(out).length, paid,
    known: nums.filter((n) => A.watchedFromStart(out, n)).length, watched: ev.some((e) => e.polls > 0), bytes: fs.statSync(file).size };
  console.log(`${league.name}: ${info.events} events paid, ${info.entries} entries, ${info.players} players, every bullet known in ${info.known}, ${Math.round(info.bytes / 1024)} KB`);
  return info;
}

(async () => {
  if (repack) {
    for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && x !== 'index.json' && x !== 'fx.json')) {
      const file = path.join(DIR, f), before = fs.statSync(file).size;
      const st = A.unpack(JSON.parse(fs.readFileSync(file, 'utf8'))); delete st.repaired; A.repair(st); // the engine's current clean-ups
      fs.writeFileSync(file, JSON.stringify(A.pack(st)));
      console.log(`${f}: ${Math.round(before / 1024)} -> ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
    const ip = path.join(DIR, 'index.json');
    if (fs.existsSync(ip)) { const ix = JSON.parse(fs.readFileSync(ip, 'utf8')); for (const s of ix.series) { try { s.bytes = fs.statSync(path.join(DIR, s.id + '.json')).size; } catch {} } fs.writeFileSync(ip, JSON.stringify(ix, null, 1)); }
    return;
  }
  if (ratesOnly) return writeRates(JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')).series);
  const indexPath = path.join(DIR, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { series: [] };
  const byId = new Map(index.series.map((s) => [s.id, s]));
  const finish = async () => {
    index.series = [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
    index.updatedAt = Math.floor(Date.now() / 1000);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
    console.log(`index: ${index.series.length} series`);
    await writeRates(index.series);
  };
  if (seriesId) {
    // A series of docs/series.js, from what the poller saved
    const s = Series.byId(seriesId);
    if (!s || s.org !== 'apt') throw new Error(`no APT series "${seriesId}" in docs/series.js`);
    if (!fromState) throw new Error('--series needs --from-state <state.json>');
    byId.set(s.source.series, await archive({ slug: s.source.series, name: s.title, startDate: s.start, endDate: s.end, currency: s.currency, tz: s.tz }));
    return finish();
  }
  const d = await (await fetchFn(`${A.SITE}/series/__data.json`)).json();
  const node = d.nodes.map((n) => (n && n.data ? A.unflatten(n.data) : null)).find((x) => x && x.pastLeagues);
  // Series still polled live (docs/series.js) keep their own tracker until they are archived with --from-state
  const live = new Set(Series.ofOrg('apt').filter(Series.pollable).map((s) => s.source.series));
  const past = node.pastLeagues.filter((l) => !live.has(l.slug) || (fromState && l.slug === only));
  for (const l of past) {
    if (only && l.slug !== only) continue;
    if (fs.existsSync(path.join(DIR, l.slug + '.json')) && !force && !fromState) { console.log('have', l.name); continue; }
    try { byId.set(l.slug, await archive(l)); } catch (e) { console.error(`${l.name}: ${e.message}`); }
    await sleep(1000);
  }
  await finish();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
