#!/usr/bin/env node
// Save every finished Gods of Poker series as a static file for the past-series pages (gop/?f=<slug>) and the
// all-series page. GOP publishes complete records (every bullet, bust and payout), so a past series is as exact as one
// watched live.
//   node tools/gop-archive.js [--only <series slug>] [--force]
//   node tools/gop-archive.js --series <id in docs/series.js> --from-state <state.json>
//        (what the poller runs when a series it watched ends)
//   node tools/gop-archive.js --rates   (only rebuild fx.json: exchange rates for every saved series' dates)
// Writes docs/gop/archive/<slug>.json, index.json and fx.json.
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../docs/gop/gop.js');
const Series = require('../docs/series.js');
const { writeRates } = require('./rates.js');

const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const only = arg('--only'), fromState = arg('--from-state'), seriesId = arg('--series');
const force = args.includes('--force'), ratesOnly = args.includes('--rates');
const DIR = path.join(__dirname, '../docs/gop/archive');
fs.mkdirSync(DIR, { recursive: true });

const fetchFn = (url, o = {}) => fetch(url, { ...o, headers: { 'User-Agent': 'apt-live-tracker (archive)', Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymdIn = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));

// "GOP Incheon 2026 II" -> place "Incheon II", tag "Incheon II '26"
function placeOf(title) {
  const yr = (title.match(/\b(20\d\d)\b/) || [])[1] || '';
  const place = title.replace(/^GOP\s+/i, '').replace(/\b20\d\d\b/, '').replace(/\s+/g, ' ').trim();
  return { place, tag: `${place} '${yr.slice(2)}` };
}

async function archive(slug, entry) {
  let state;
  if (fromState) state = JSON.parse(fs.readFileSync(fromState, 'utf8'));
  else {
    G.configure({ series: slug });
    state = G.emptyState();
    // Round 1 reads the list and every event; later rounds retry what failed
    for (let round = 1; round <= 4; round++) {
      const s = await G.pollOnce(state, { fetchFn, concurrency: 3 });
      if (s.errors.length) console.warn(`  round ${round}: ${s.errors.length} errors (${s.errors.slice(0, 2).join(' | ')})`);
      if (!s.errors.length) break;
      await sleep(3000);
    }
  }
  G.repair(state);
  const out = G.slim(state);
  const file = path.join(DIR, slug + '.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const f = state.festival || {}, tz = f.timezone || (entry && entry.tz) || 'UTC';
  const ev = Object.values(out.events);
  const starts = ev.map((e) => e.start).filter(Boolean);
  const nums = [...new Set(ev.map((e) => e.num))];
  const official = (num) => {
    const kids = ev.filter((e) => e.num === num), later = kids.filter((e) => G.isLaterDay(e.name));
    return later.length ? Math.max(...later.map((e) => e.entries || 0)) : kids.reduce((a, e) => a + (e.entries || 0), 0);
  };
  const title = (entry && entry.title) || f.title || slug;
  const { place, tag } = placeOf(f.title || title);
  const info = { id: slug, name: f.title || title, place, tag, start: entry ? entry.start : ymdIn(Math.min(...starts), tz), end: entry ? entry.end : ymdIn(Math.max(...starts), tz),
    tz, currency: (entry && entry.currency) || (ev[0] && ev[0].currency) || 'USD',
    events: nums.filter((n) => out.results[n] && out.results[n].rows.length).length, entries: nums.reduce((a, n) => a + official(n), 0),
    players: G.players(out).length, paid: Object.values(out.results).reduce((a, r) => a + r.rows.reduce((b, row) => b + row[3], 0), 0),
    played: nums.filter((n) => official(n) > 0).length, known: nums.filter((n) => official(n) > 0 && G.watchedFromStart(out, n)).length, watched: !!fromState, bytes: fs.statSync(file).size };
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
  if (seriesId) {
    const s = Series.byId(seriesId);
    if (!s || s.org !== 'gop') throw new Error(`no GOP series "${seriesId}" in docs/series.js`);
    if (!fromState) throw new Error('--series needs --from-state <state.json>');
    byId.set(s.source.series, await archive(s.source.series, s));
    return finish();
  }
  // Every series the site lists as complete; one still polled (docs/series.js) is archived by its poller instead
  const list = await G.getData(fetchFn, `${G.SITE}/series/__data.json`);
  const polled = new Set(Series.ofOrg('gop').filter(Series.pollable).map((s) => s.source.series));
  const done = (list.festivals || list.series || []).filter((f) => f.isComplete && f.production !== false && !polled.has(f.slug));
  for (const f of done) {
    if (only && f.slug !== only) continue;
    if (fs.existsSync(path.join(DIR, f.slug + '.json')) && !force) { console.log('have', f.title); continue; }
    try { byId.set(f.slug, await archive(f.slug, Series.LIST.find((x) => x.org === 'gop' && x.source.series === f.slug))); } catch (e) { console.error(`${f.title}: ${e.message}`); }
    await sleep(1000);
  }
  await finish();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
