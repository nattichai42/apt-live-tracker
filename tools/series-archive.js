#!/usr/bin/env node
// Save every finished series of an organiser whose engine rebuilds its state from the site's records (Gods of Poker,
// Royal Poker Tour) as a static file, for the past-series pages (<org>/?f=<slug>) and the all-series page.
//   node tools/series-archive.js --org gop|rop [--only <series slug>] [--force]
//   node tools/series-archive.js --series <id in docs/series.js> --from-state <state.json>
//        (what the poller runs when a series it watched ends; the organiser comes from the series)
//   node tools/series-archive.js --org gop|rop --rates   (only rebuild fx.json for every saved series' dates)
// Writes docs/<org>/archive/<slug>.json, index.json and fx.json (tools/rates.js).
'use strict';
const fs = require('fs');
const path = require('path');
const Series = require('../docs/series.js');
const { writeRates } = require('./rates.js');

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const only = arg('--only'), fromState = arg('--from-state'), seriesId = arg('--series');
const force = args.includes('--force'), ratesOnly = args.includes('--rates');
const entry = seriesId ? Series.byId(seriesId) : null;
if (seriesId && !entry) { console.error(`no series "${seriesId}" in docs/series.js`); process.exit(2); }
const ORG = entry ? entry.org : arg('--org');
const O = Series.ORGANISERS[ORG];
if (!O || !O.archive || O.archive.tool !== 'tools/series-archive.js') { console.error(`--org: one of ${Object.keys(Series.ORGANISERS).filter((o) => (Series.ORGANISERS[o].archive || {}).tool === 'tools/series-archive.js').join(', ')}`); process.exit(2); }
const E = require(path.join(__dirname, '../docs', O.engine));
const DIR = path.join(__dirname, '../docs', O.archive.dir);
fs.mkdirSync(DIR, { recursive: true });

const fetchFn = (url, o = {}) => fetch(url, { ...o, headers: { 'User-Agent': 'apt-live-tracker (archive)', Accept: 'application/json', ...(o.headers || {}) }, signal: AbortSignal.timeout(60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymdIn = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));

// "GOP Incheon 2026 II" -> place "Incheon II", tag "Incheon II '26"; "RPT Championship IV" (2026) -> "Championship IV '26"
function placeOf(title, start) {
  const yr = (title.match(/\b(20\d\d)\b/) || [])[1] || String(start || '').slice(0, 4);
  const place = title.replace(new RegExp(`^(${O.name}|GOP|RPT)\\s+`, 'i'), '').replace(/\b20\d\d\b/, '').replace(/\s+/g, ' ').replace(/^[-–\s]+|[-–\s]+$/g, '').trim();
  return { place, tag: `${place} '${yr.slice(2)}` };
}

async function archive(slug, name, entry) {
  let state;
  if (fromState) state = JSON.parse(fs.readFileSync(fromState, 'utf8'));
  else {
    E.configure({ series: slug });
    state = E.emptyState();
    // Round 1 reads the list and every event; later rounds retry what failed
    for (let round = 1; round <= 4; round++) {
      const s = await E.pollOnce(state, { fetchFn, concurrency: 3 });
      if (s.errors.length) console.warn(`  round ${round}: ${s.errors.length} errors (${s.errors.slice(0, 2).join(' | ')})`);
      if (!s.errors.length) break;
      await sleep(3000);
    }
    const unread = Object.values(state.events).filter((e) => !e.polls).length;
    if (unread) throw new Error(`${unread} events still unread after 4 rounds: not saved`);
  }
  E.repair(state);
  const out = E.slim(state);
  if (!E.players(out).length) throw new Error('no players on record (the site has only its schedule): not saved');
  const file = path.join(DIR, slug + '.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const f = state.festival || {}, tz = f.timezone || (entry && entry.tz) || 'UTC';
  const ev = Object.values(out.events);
  const starts = ev.map((e) => e.start).filter(Boolean);
  const nums = [...new Set(ev.map((e) => e.num))];
  const official = (num) => {
    const kids = ev.filter((e) => e.num === num), later = kids.filter((e) => E.isLaterDay(e.name));
    const counted = later.length ? Math.max(...later.map((e) => e.entries || 0)) : kids.reduce((a, e) => a + (e.entries || 0), 0);
    // no entry count on record: the bullets seen
    return counted || kids.reduce((a, e) => a + Object.values(e.p || {}).reduce((x, p) => x + (p.b || 0), 0), 0);
  };
  const title = f.title || f.name || name || (entry && entry.name) || slug;
  const start = entry ? entry.start : ymdIn(Math.min(...starts), tz), end = entry ? entry.end : ymdIn(Math.max(...starts), tz);
  const { place, tag } = placeOf(title, start);
  const info = { id: slug, name: title, place, tag, start, end, tz, currency: (entry && entry.currency) || (ev[0] && ev[0].currency) || 'USD',
    events: nums.filter((n) => out.results[n] && out.results[n].rows.length).length, entries: nums.reduce((a, n) => a + official(n), 0),
    players: E.players(out).length, paid: Object.values(out.results).reduce((a, r) => a + r.rows.reduce((b, row) => b + row[3], 0), 0),
    played: nums.filter((n) => official(n) > 0).length, known: nums.filter((n) => official(n) > 0 && E.watchedFromStart(out, n)).length,
    watched: !!fromState, bytes: fs.statSync(file).size };
  console.log(`${info.name}: ${info.events} events paid, ${info.entries} entries, ${info.players} players, every bullet known in ${info.known} of ${info.played} played, ${Math.round(info.bytes / 1024)} KB`);
  return info;
}

(async () => {
  const indexPath = path.join(DIR, 'index.json');
  const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { series: [] };
  const byId = new Map(index.series.map((s) => [s.id, s]));
  const finish = async () => {
    index.series = [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
    index.updatedAt = Math.floor(Date.now() / 1000);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
    console.log(`index: ${index.series.length} series`);
    await writeRates(DIR, index.series);
  };
  if (ratesOnly) return writeRates(DIR, index.series);
  if (entry) {
    if (!fromState) throw new Error('--series needs --from-state <state.json>');
    byId.set(entry.source.series, await archive(entry.source.series, entry.name, entry));
    return finish();
  }
  // Every finished series on the site; one still polled (docs/series.js) is archived by its poller instead
  const polled = new Set(Series.ofOrg(ORG).filter(Series.pollable).map((s) => s.source.series));
  for (const f of (await E.finished(fetchFn)).filter((x) => !polled.has(x.slug))) {
    if (only && f.slug !== only) continue;
    if (fs.existsSync(path.join(DIR, f.slug + '.json')) && !force) { console.log('have', f.name); continue; }
    try { byId.set(f.slug, await archive(f.slug, f.name, Series.LIST.find((x) => x.org === ORG && x.source.series === f.slug))); } catch (e) { console.error(`${f.name}: ${e.message}`); }
    await sleep(1000);
  }
  await finish();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
