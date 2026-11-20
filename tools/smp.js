// Read a finished festival from SoMuchPoker's event calendar (somuchpoker.com/events-calendar/<tour>/<year>/<festival>)
// into the GLPC engine's state shape, for organisers whose festivals aren't on a tracker of their own (USOP outside
// Grand Loyal's). Used by tools/series-archive.js for a docs/series.js entry with source: { smp: '<festival path>' }.
//
// What the calendar serves (in each page's embedded Next.js data):
//   - the festival's schedule (every event page carries it): number, name, buy-in ("22,000 JPY"), dates, link
//   - per event: entries, total prize, and the winner's prize in the local currency ("(¥500,000)")
//   - per event, /payouts: every paid place with the player and country, and a prize in USD ("$$257,590") where
//     SoMuchPoker has the amounts; elsewhere "$$0" (places known, prizes not)
// Events with no payouts there are left out. No entries per player, re-entries or bust times.
'use strict';
const fs = require('fs');
const path = require('path');
const { FX } = require('../docs/fx.js');

const SITE = 'https://somuchpoker.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'apt-live-tracker (archive)' }, signal: AbortSignal.timeout(60000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const s = await r.text();
      // The page's data: the Next.js flight chunks, joined
      return [...s.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse('"' + m[1] + '"')).join('');
    } catch (e) { if (i === 3) throw e; await sleep(2000 * (i + 1)); }
  }
}
// "22,000 JPY" / "VND 5,500,000" / "$1,100" -> [amount, currency]
function money(s, fallback) {
  const t = String(s || '');
  const cur = (t.match(/\b(JPY|VND|USD|TWD|KRW|PHP|THB|HKD|SGD|MYR|CNY|AUD|EUR|GBP|INR)\b/) || [])[1] || (/\$/.test(t) ? 'USD' : /¥/.test(t) ? 'JPY' : /₫/.test(t) ? 'VND' : fallback);
  const n = Number((t.match(/[\d][\d,.]*/) || ['0'])[0].replace(/,/g, ''));
  const k = /\d\s*K\b/i.test(t) ? 1e3 : /\d\s*M\b/.test(t) ? 1e6 : /\d\s*B\b/.test(t) ? 1e9 : 1;
  return [Math.round(n * k), cur];
}
// A details figure: the <dd> after its <dt> label (an icon sits between them)
const after = (t, label) => { const m = t.match(new RegExp(`"children":"${label}"\\}\\][\\s\\S]{0,1500}?\\["\\$","dd",null,\\{"className":"[^"]*","children":"([^"]+)"`)); return m ? m[1] : null; };

/**
 * entry: the docs/series.js entry ({ source: { smp }, currency, tz, start, end }).
 * ratesFile: the archive's fx.json (USD rates for converting a buy-in to the payouts' USD)
 */
async function read(entry, ratesFile) {
  const fest = entry.source.smp, local = entry.currency || 'USD';
  try { FX.seed(JSON.parse(fs.readFileSync(ratesFile, 'utf8'))); } catch {}
  // The schedule, from the festival's schedule page (its event links) and an event page (their details)
  const sched = await page(`${SITE}${fest}/schedule`);
  const hrefs = [...new Set([...(sched || '').matchAll(new RegExp(`"(${fest.replace(/[/-]/g, (c) => '\\' + c)}/[a-z0-9-]+)"`, 'g'))].map((m) => m[1]))]
    .filter((h) => !/\/(schedule|gallery|statistics|photos|leaderboard|news|live-updates)$/.test(h));
  const info = new Map();
  const first = hrefs.length ? await page(SITE + hrefs[0]) : '';
  for (const m of (first || '').matchAll(/\{"number":"([^"]*)","name":"([^"]*)","buyIn":"([^"]*)","startDate":"([^"]*)","endDate":"([^"]*)","href":"([^"]+)"/g)) {
    info.set(m[6], { number: m[1], name: m[2], buyIn: m[3], start: m[4], end: m[5] });
  }
  const state = { v: 1, series: entry.source.series, archive: true, source: 'somuchpoker', updatedAt: Math.floor(Date.now() / 1000), events: {}, results: {}, feed: [], aliases: {} };
  let n = 0, synth = 900;
  for (const href of hrefs) {
    const pay = await page(`${SITE}${href}/payouts`);
    const m = pay && pay.match(/\{"payouts":(\[.*?\])\s*[,}]/);
    const rows = m ? JSON.parse(m[1]) : [];
    if (!rows.length) continue; // nothing published
    const det = await page(SITE + href) || '';
    const i = info.get(href) || {};
    // Older pages carry no schedule or details: the payouts page's title and description fill in
    const title = (pay.match(/"children":"([^"]+) Payouts & Results \| /) || [])[1] || i.name || href.split('/').pop();
    const desc = (pay.match(/"name":"description","content":"([^"]+)"/) || [])[1] || '';
    const num = i.number && /^\w+$/.test(i.number) ? i.number : (title.match(/^#(\w+)\b/) || href.split('/').pop().match(/^(\d+)-/) || [])[1] || String(++synth);
    if (!i.buyIn) i.buyIn = (title.match(/\(([\d,.]+\s*(?:JPY|VND|USD|TWD|KRW|PHP))\)/) || [])[1];
    const start = Math.floor(Date.parse((i.start || entry.start) + 'T12:00:00Z') / 1000) - 3 * 3600;
    const [buyLocal, buyCur] = money(i.buyIn, local);
    const usdPrizes = rows.some((r) => money(r.prize, 'USD')[0] > 0);
    // In USD when SoMuchPoker gives the amounts (its prizes are in USD); else the local currency, with the winner's prize
    const cur = usdPrizes ? 'USD' : buyCur;
    const day = (i.start || entry.start);
    const conv = (v, from) => { if (from === cur || !v) return v; const f = FX.factor(from, cur, day); return f ? Math.round(v * f) : 0; };
    // the winner's prize, in brackets under their name (the last bracketed amount; the first is the buy-in)
    const winLocal = ([...det.matchAll(/"children":\["\(","([^"]+)","\)"\]/g)].pop() || [])[1];
    const results = rows.map((r) => [Number(r.position), (r.name || '').trim(), String(r.countryCode || '').toUpperCase(),
      usdPrizes ? money(r.prize, 'USD')[0] : Number(r.position) === 1 && winLocal ? conv(...money(winLocal, buyCur)) : 0]).filter((r) => r[0] > 0 && r[1]);
    const [pool, poolCur] = money(after(det, 'Total Prize') || (desc.match(/total prize pool ([\d.,]+\s*[KMB]?\s*[A-Z]{3})/i) || [])[1], buyCur);
    const name = title.replace(/^#\S+\s+/, '').replace(/\s*\([\d,.]+\s*[A-Z]{3}\)\s*$/, '');
    const e = { kid: 'smp:' + href.split('/').pop(), num, name, base: name, raw: title, currency: cur,
      start, doneAt: Math.floor(Date.parse((i.end || i.start || entry.end) + 'T20:00:00Z') / 1000) - 3 * 3600, buyin: conv(buyLocal, buyCur),
      entries: Number(String(after(det, 'Entries') || '').replace(/[^\d]/g, '')) || null, prizePool: conv(pool, poolCur),
      phase: 'Completed', polls: 1, p: {}, sat: /satellite/i.test(title), ord: Number(num) || 9999 };
    state.events[e.kid] = e;
    state.results[num] = { at: state.updatedAt, final: true, rows: results.sort((a, b) => a[0] - b[0]), amounts: usdPrizes ? 'all' : 'winner' };
    n++;
    await sleep(300);
  }
  return { state, events: n, listed: hrefs.length };
}
module.exports = { read, money };

/**
 * Put SoMuchPoker's payouts into a festival read from Grand Loyal's tracker (GLPC engine state, VND), where the
 * tracker keeps only a finished event's top few places and its leaderboard ranks follow the chips when play stopped
 * (a deal or the final hand can order the top places differently). For each event on both:
 *   - places and players from SoMuchPoker; a player matched to the event's entrant of the same name (any word order,
 *     or SoMuchPoker's name being part of the tracker's: "Arjun Agrawal" / "Agrawal Arjun Pulak"), else as published
 *   - amounts: the tracker's VND where it has that place, else SoMuchPoker's USD at the rate the two give for the
 *     events both pay (the median of first prizes), to the nearest 1,000 VND
 * Events only SoMuchPoker has join as results-only events; the tracker's others (satellites) stay as they were.
 * Returns { merged, added, rate }.
 */
function mergeInto(gl, smp) {
  const People = require('../docs/people.js');
  const words = (n) => People.norm(n).split(' ').filter(Boolean);
  const kidsOf = (num) => Object.values(gl.events).filter((e) => e.num === num);
  const ratios = [];
  for (const [num, r] of Object.entries(smp.results)) {
    const g = gl.results[num], s1 = r.rows.find((x) => x[0] === 1), g1 = g && g.rows.find((x) => x[0] === 1);
    if (s1 && g1 && s1[3] > 0 && g1[3] > 0 && kidsOf(num).length) ratios.push(g1[3] / s1[3]);
  }
  ratios.sort((a, b) => a - b);
  // (no event paid on both: the day's exchange rate, from the archive's rates)
  const first = Object.values(smp.events).map((e) => e.start).filter(Boolean).sort((a, b) => a - b)[0];
  const rate = ratios.length ? ratios[ratios.length >> 1] : first ? FX.factor('USD', 'VND', FX.ymd(first)) : null;
  if (!rate) throw new Error('no event paid on both and no exchange rate: SoMuchPoker\'s USD not converted');
  let merged = 0, added = 0;
  for (const [num, r] of Object.entries(smp.results)) {
    const kids = kidsOf(num), g = gl.results[num];
    const vndAt = new Map(((g && g.rows) || []).map((x) => [x[0], x[3]]));
    const vnd = (pos, usd) => (vndAt.has(pos) ? vndAt.get(pos) : Math.round((usd * rate) / 1000) * 1000);
    if (!kids.length) {
      // Only on SoMuchPoker: a results-only event, in VND
      const se = Object.values(smp.events).find((e) => e.num === num); if (!se) continue;
      const e = { ...se, kid: se.kid, currency: 'VND', buyin: Math.round((se.buyin * (se.currency === 'USD' ? rate : 1)) / 1000) * 1000,
        prizePool: Math.round((se.prizePool * (se.currency === 'USD' ? rate : 1)) / 1000) * 1000, src: 'somuchpoker' };
      gl.events[e.kid] = e;
      gl.results[num] = { at: smp.updatedAt, final: true, src: 'somuchpoker', rows: r.rows.map(([pos, n, cc, usd]) => [pos, n, cc, vnd(pos, usd)]) };
      added++; continue;
    }
    // The event's entrants, to name each place as the tracker does
    const entrants = new Map();
    for (const e of kids) for (const [k, p] of Object.entries(e.p || {})) entrants.set(k, p.cc || '');
    const exact = new Map(), list = [...entrants.keys()].map((k) => [k, new Set(words(k))]);
    for (const [k] of list) { const n = People.norm(k); exact.set(n, exact.has(n) ? null : k); }
    const nameOf = (n) => {
      const hit = exact.get(People.norm(n)); if (hit) return hit;
      const w = words(n); if (w.length < 2) return null;
      const sub = list.filter(([, set]) => w.every((x) => set.has(x)));
      return sub.length === 1 ? sub[0][0] : null;
    };
    gl.results[num] = { at: (g && g.at) || smp.updatedAt, final: true, src: 'somuchpoker',
      rows: r.rows.map(([pos, n, cc, usd]) => { const k = nameOf(n); return [pos, k || n, cc || (k && entrants.get(k)) || '', vnd(pos, usd)]; }) };
    merged++;
  }
  return { merged, added, rate: Math.round(rate) };
}
module.exports.mergeInto = mergeInto;
