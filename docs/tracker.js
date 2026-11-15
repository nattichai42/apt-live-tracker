/*
 * APT live tracker engine. Shared by the GitHub Actions poller (Node) and the live page (browser).
 *
 * The Asian Poker Tour site publishes, for every running event, the list of players currently
 * seated (live seating). Busts and re-entries are not published, so they are inferred by
 * diffing consecutive snapshots:
 *   - a player whose seat disappears has busted (time = the poll that first saw them gone)
 *   - a busted player who reappears has re-entered (bullet + 1)
 *   - a player who reappears in the same seat within a few polls was a data glitch, not a bust
 * The official entry counter minus the bullets we saw = bullets we could not attribute
 * (fired before tracking began, or bust + re-entry faster than one poll).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APTTracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SITE = 'https://www.theasianpokertour.com';
  const SERIES = 'apt-championship-taipei-2026';
  const BASE = `${SITE}/series/${SERIES}/events`;
  const ACTIVE = new Set(['Late Reg', 'Running', 'In The Money', 'Reg Open', 'Final Table', 'Break', 'Paused']);
  const FEED_CAP = 5000;

  const nowSec = () => Math.floor(Date.now() / 1000);
  const toSec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // SvelteKit "devalue" payload -> plain JS
  function unflatten(arr) {
    const cache = new Map();
    const h = (i) => {
      if (typeof i !== 'number' || i < 0) return null;
      if (cache.has(i)) return cache.get(i);
      const v = arr[i];
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string' && ['Date', 'Set', 'Map', 'BigInt', 'RegExp'].includes(v[0])) { const o = v[0] === 'Date' ? v[1] : v; cache.set(i, o); return o; }
        const out = []; cache.set(i, out); v.forEach((x) => out.push(h(x))); return out;
      }
      if (v && typeof v === 'object') { const out = {}; cache.set(i, out); for (const k of Object.keys(v)) out[k] = h(v[k]); return out; }
      cache.set(i, v); return v;
    };
    return h(0);
  }
  async function getData(fetchFn, url) {
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const j = await r.json();
    const nodes = (j.nodes || []).map((n) => (n && n.type === 'data' ? unflatten(n.data) : null));
    return nodes[nodes.length - 1] || {};
  }

  function emptyState() {
    return { v: 1, series: SERIES, updatedAt: 0, listAt: 0, events: {}, results: {}, feed: [] };
  }

  const isLaterDay = (name) => /\b(Day [2-9]|Final Day|Final Table)\b/i.test(name || '');

  function eventMeta(e) {
    return {
      kid: e.kholdemId, num: e.number, name: clean(e.name), phase: e.phase,
      start: toSec(e.startTimeUTC), regClose: toSec(e.regCloseUTC),
      buyin: Math.round(Number(e.buyin || 0) + Number(e.fee || 0)), currency: e.currency || 'TWD',
      entries: e.totalEntries ?? null, remaining: e.playersRemaining ?? null,
      sat: !!e.isSatellite, prizePool: Math.round(Number(e.prizePool || 0)),
    };
  }

  async function fetchEventList(fetchFn) {
    const d = await getData(fetchFn, `${BASE}/__data.json`);
    return (d.events || []).filter((e) => e && e.kholdemId).map(eventMeta);
  }

  // Merge list metadata into state; returns kids worth polling now.
  function mergeList(state, list, now) {
    for (const m of list) {
      const e = state.events[m.kid] || (state.events[m.kid] = { kid: m.kid, p: {}, seats: {}, polls: 0 });
      Object.assign(e, m);
    }
    state.listAt = now;
  }

  function activeKids(state, now) {
    return Object.values(state.events)
      .filter((e) => (ACTIVE.has(e.phase) && e.start && e.start <= now + 300) ||
        (e.phase === 'Completed' && e.polls > 0 && !e.closed))
      .map((e) => e.kid);
  }

  function pushFeed(state, item) {
    state.feed.push(item);
    if (state.feed.length > FEED_CAP) state.feed.splice(0, state.feed.length - FEED_CAP);
  }

  // Core diff. players: [{name, cc, country, table, seat}]
  function applySnapshot(state, kid, players, now, interval) {
    const e = state.events[kid];
    const prev = e.seats || {};
    const prevCount = Object.keys(prev).length;
    const cur = {};
    for (const p of players) { const n = clean(p.name); if (n) cur[n] = [p.tableIndex ?? p.table ?? null, p.seatIndex ?? p.seat ?? null, p.countryCode || p.cc || '']; }
    const curCount = Object.keys(cur).length;
    const res = { busts: 0, reentries: 0, entries: 0, skipped: false };

    // Sanity guards against empty or half-loaded snapshots
    if (curCount === 0 && prevCount > 3 && e.phase !== 'Completed') { res.skipped = true; return res; }
    if (prevCount > 15 && curCount < prevCount * 0.55 && e.phase !== 'Completed') { res.skipped = true; return res; }

    const siblings = Object.values(state.events).filter((x) => x.num === e.num && x.kid !== kid);
    const carried = (n) => isLaterDay(e.name) && siblings.some((x) => x.p[n] && x.p[n].st === 'end');

    if (!e.firstPoll) {
      e.firstPoll = now;
      for (const [n, s] of Object.entries(cur)) {
        const c = carried(n);
        e.p[n] = { b: c ? 0 : 1, st: 's', f: now, l: now, x: [], cc: s[2], seat: [s[0], s[1]], ...(c ? { carry: 1 } : {}) };
      }
      e.entriesAtFirst = e.entries;
    } else {
      const glitchWindow = Math.max(3 * (interval || 60), 180);
      for (const n of Object.keys(prev)) {
        if (cur[n]) continue;
        const p = e.p[n];
        if (!p || p.st !== 's') continue;
        if (e.phase === 'Completed') continue; // handled below
        p.st = 'x'; p.x.push(now); res.busts++;
        pushFeed(state, { t: now, kid, num: e.num, n, k: 'bust', b: p.b || 1, cc: p.cc });
      }
      for (const [n, s] of Object.entries(cur)) {
        const p = e.p[n];
        if (prev[n]) { if (p) { p.seat = [s[0], s[1]]; p.l = now; } continue; }
        if (!p) {
          const c = carried(n);
          e.p[n] = { b: c ? 0 : 1, st: 's', f: now, l: now, x: [], cc: s[2], seat: [s[0], s[1]], ...(c ? { carry: 1 } : {}) };
          if (!c) { res.entries++; pushFeed(state, { t: now, kid, num: e.num, n, k: 'entry', b: 1, cc: s[2] }); }
          continue;
        }
        if (p.st === 'x') {
          const last = p.x[p.x.length - 1];
          const sameSeat = p.seat && p.seat[0] === s[0] && p.seat[1] === s[1];
          if (sameSeat && now - last <= glitchWindow) {
            // Not a real bust: undo it
            p.x.pop(); res.busts--;
            for (let i = state.feed.length - 1; i >= 0; i--) {
              const f = state.feed[i];
              if (f.kid === kid && f.n === n && f.k === 'bust' && f.t === last) { state.feed.splice(i, 1); break; }
            }
          } else {
            p.b = (p.b || 0) + 1; res.reentries++;
            pushFeed(state, { t: now, kid, num: e.num, n, k: 'reentry', b: p.b, cc: s[2] });
          }
        }
        p.st = 's'; p.seat = [s[0], s[1]]; p.l = now; if (s[2]) p.cc = s[2];
      }
    }

    if (e.phase === 'Completed') {
      // Whoever is still listed at the end survived (bagged a flight, or won)
      for (const n of Object.keys(cur)) if (e.p[n]) e.p[n].st = 'end';
      for (const [n, p] of Object.entries(e.p)) if (p.st === 's' && !cur[n]) { p.st = 'x'; p.x.push(now); }
      e.closed = 1;
    }
    e.seats = cur;
    e.lastPoll = now;
    e.polls = (e.polls || 0) + 1;
    e.seated = curCount;
    return res;
  }

  async function fetchResults(fetchFn, state, num, now) {
    const kids = Object.values(state.events).filter((x) => x.num === num).sort((a, b) => (b.start || 0) - (a.start || 0));
    if (!kids.length) return false;
    const d = await getData(fetchFn, `${BASE}/${kids[0].kid}/results/__data.json`);
    const rows = (d.results || []).filter((r) => r && r.name).map((r) => [r.position, clean(r.name), r.countryCode || '', Math.round(r.amount || 0)]);
    const final = kids.every((x) => x.phase === 'Completed');
    state.results[num] = { at: now, final, rows };
    return true;
  }

  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String(err && err.message || err) }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  /**
   * One polling round. opts: {fetchFn, interval (s), listEvery (s), resultsEvery (s), concurrency}
   * Returns a summary.
   */
  async function pollOnce(state, opts = {}) {
    const fetchFn = opts.fetchFn || ((u) => fetch(u, { cache: 'no-store' }));
    const interval = opts.interval || 60;
    const now = nowSec();
    const summary = { at: now, events: 0, busts: 0, reentries: 0, entries: 0, errors: [] };
    if (!state.listAt || now - state.listAt >= (opts.listEvery || 300) || !Object.keys(state.events).length) {
      try { mergeList(state, await fetchEventList(fetchFn), now); } catch (err) { summary.errors.push('list: ' + err.message); }
    }
    const kids = activeKids(state, now);
    const got = await pool(kids, opts.concurrency || 4, async (kid) => {
      const [ev, ls] = await Promise.all([
        getData(fetchFn, `${BASE}/${kid}/__data.json`),
        getData(fetchFn, `${BASE}/${kid}/live-seating/__data.json`),
      ]);
      return { kid, ev: ev.event, players: (ls && ls.players) || null };
    });
    for (const g of got) {
      if (!g || g.error) { summary.errors.push(g ? g.error : 'unknown'); continue; }
      const e = state.events[g.kid];
      if (g.ev) Object.assign(e, eventMeta({ ...g.ev, startTimeUTC: g.ev.startTimeUTC, regCloseUTC: g.ev.regCloseUTC || (e.regClose ? new Date(e.regClose * 1000).toISOString() : null) }));
      if (g.ev && g.ev.startingStack) e.stack = g.ev.startingStack;
      if (!g.players) { if (e.phase === 'Completed') e.closed = 1; continue; }
      const r = applySnapshot(state, g.kid, g.players, now, interval);
      summary.events++; summary.busts += r.busts; summary.reentries += r.reentries; summary.entries += r.entries;
    }
    // Results: in-the-money events every resultsEvery, completed ones once (final)
    const nums = [...new Set(Object.values(state.events).map((e) => e.num))];
    const want = nums.filter((num) => {
      const evs = Object.values(state.events).filter((e) => e.num === num);
      const r = state.results[num];
      const anyItm = evs.some((e) => e.phase === 'In The Money' || e.phase === 'Final Table');
      const allDone = evs.every((e) => e.phase === 'Completed');
      if (allDone) return !r || !r.final;
      if (anyItm) return !r || now - r.at >= (opts.resultsEvery || 300);
      return false;
    });
    await pool(want, opts.concurrency || 4, (num) => fetchResults(fetchFn, state, num, now));
    state.updatedAt = now;
    return summary;
  }

  /* ---------- Derived views ---------- */

  function resultsByName(state) {
    const m = new Map();
    for (const [num, r] of Object.entries(state.results)) for (const [pos, n, cc, prize] of r.rows) {
      if (!m.has(n)) m.set(n, []);
      m.get(n).push({ num: Number(num), pos, prize, cc, final: r.final });
    }
    return m;
  }

  function eventByNum(state) {
    const m = new Map();
    for (const e of Object.values(state.events)) {
      const cur = m.get(e.num);
      if (!cur || (e.start || 0) < (cur.start || 0)) m.set(e.num, e);
    }
    return m;
  }

  // One row per player across the series
  function players(state) {
    const byNum = eventByNum(state);
    const res = resultsByName(state);
    const map = new Map();
    const get = (n) => map.get(n) || (map.set(n, { name: n, cc: '', nums: new Map(), bullets: 0, busts: 0, seatedIn: [], lastBust: 0, cashes: [], untracked: 0 }), map.get(n));
    for (const e of Object.values(state.events)) {
      for (const [n, p] of Object.entries(e.p || {})) {
        const r = get(n); if (p.cc) r.cc = p.cc;
        const k = r.nums.get(e.num) || { num: e.num, bullets: 0, buyin: e.buyin, tracked: true };
        k.bullets += p.b || 0; r.nums.set(e.num, k);
        r.bullets += p.b || 0; r.busts += (p.x || []).length;
        if (p.st === 's' && e.phase !== 'Completed') r.seatedIn.push(e.num);
        const lb = (p.x || [])[p.x.length - 1]; if (lb && lb > r.lastBust) r.lastBust = lb;
      }
    }
    for (const [n, cs] of res) {
      const r = get(n); if (!r.cc && cs[0].cc) r.cc = cs[0].cc;
      for (const c of cs) {
        r.cashes.push(c);
        if (!r.nums.has(c.num)) {
          const ev = byNum.get(c.num);
          r.nums.set(c.num, { num: c.num, bullets: 1, buyin: ev ? ev.buyin : 0, tracked: false });
          r.bullets += 1; r.untracked += 1;
        }
      }
    }
    // A player only seen as a carry-over (later day) entered a flight we did not track: count one bullet
    for (const r of map.values()) for (const k of r.nums.values()) if (k.bullets === 0) { k.bullets = 1; k.tracked = false; r.bullets += 1; r.untracked += 1; }
    const out = [];
    for (const r of map.values()) {
      let buyins = 0; for (const k of r.nums.values()) buyins += k.bullets * (k.buyin || 0);
      const prizes = r.cashes.reduce((s, c) => s + c.prize, 0);
      const cashedNums = new Set(r.cashes.map((c) => c.num));
      const entered = r.nums.size;
      out.push({ name: r.name, cc: r.cc, events: entered, bullets: r.bullets, reentries: Math.max(0, r.bullets - entered), busts: r.busts,
        buyins, prizes, net: prizes - buyins, cashes: r.cashes.length, itm: entered ? cashedNums.size / entered : 0,
        seatedIn: r.seatedIn, lastBust: r.lastBust || null, partial: r.untracked > 0 });
    }
    out.sort((a, b) => b.prizes - a.prizes || b.bullets - a.bullets || a.name.localeCompare(b.name));
    return out;
  }

  // Timeline for one player
  function playerTimeline(state, name) {
    const items = [];
    for (const e of Object.values(state.events)) {
      const p = e.p && e.p[name]; if (!p) continue;
      items.push({ t: p.f, k: p.carry ? 'carry' : 'seen', num: e.num, kid: e.kid, ev: e.name, first: e.firstPoll === p.f });
      (p.x || []).forEach((t, i) => items.push({ t, k: 'bust', num: e.num, kid: e.kid, ev: e.name, b: i + 1 }));
      if (p.st === 'end') items.push({ t: e.lastPoll, k: 'end', num: e.num, kid: e.kid, ev: e.name });
    }
    for (const f of state.feed) if (f.n === name && f.k === 'reentry') items.push({ t: f.t, k: 'reentry', num: f.num, kid: f.kid, ev: (state.events[f.kid] || {}).name, b: f.b });
    const byNum = eventByNum(state);
    for (const [num, r] of Object.entries(state.results)) for (const [pos, n, , prize] of r.rows) if (n === name) {
      const ev = byNum.get(Number(num));
      const kids = Object.values(state.events).filter((x) => x.num === Number(num));
      const tracked = kids.some((x) => x.polls > 0);
      const lastPoll = Math.max(0, ...kids.map((x) => x.lastPoll || 0));
      const lastStart = Math.max(0, ...kids.map((x) => x.start || 0));
      // Events that finished before tracking: we only know the day, not the bust time
      items.push(tracked ? { t: r.final ? (lastPoll || r.at) : r.at, k: 'cash', num: Number(num), ev: ev ? ev.name : '#' + num, pos, prize }
        : { t: lastStart || r.at, approx: true, k: 'cash', num: Number(num), ev: ev ? ev.name : '#' + num, pos, prize });
    }
    items.sort((a, b) => (a.t || 0) - (b.t || 0));
    return items;
  }

  function liveEvents(state, now) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.polls > 0 && (e.phase !== 'Completed' || now - (e.lastPoll || 0) < 3600))
      .map((e) => {
        const ps = Object.values(e.p || {});
        const sibs = Object.values(state.events).filter((x) => x.num === e.num);
        // Untracked bullets only make sense when every flight of this event was watched from its start
        const fullyTracked = sibs.every((x) => !x.start || x.start > now || (x.firstPoll && x.firstPoll - x.start < 900));
        const seenAll = sibs.reduce((s, x) => s + Object.values(x.p || {}).reduce((a, p) => a + (p.b || 0), 0), 0);
        const seen = ps.reduce((s, p) => s + (p.b || 0), 0);
        const re = ps.reduce((s, p) => s + Math.max(0, (p.b || 0) - 1), 0);
        const recent = state.feed.filter((f) => f.kid === e.kid && f.k === 'bust' && now - f.t <= 900).length;
        return { kid: e.kid, num: e.num, name: e.name, phase: e.phase, start: e.start, regClose: e.regClose, buyin: e.buyin,
          entries: e.entries, remaining: e.remaining, seated: e.seated, unique: ps.filter((p) => !p.carry).length,
          reentriesSeen: re, untracked: e.entries == null ? null : (isLaterDay(e.name) || sibs.length > 1) ? (fullyTracked ? Math.max(0, e.entries - seenAll) : null) : Math.max(0, e.entries - seen),
          trackedFromStart: !!(e.firstPoll && e.start && e.firstPoll - e.start < 900),
          bustsLast15: recent, firstPoll: e.firstPoll, lastPoll: e.lastPoll, sat: e.sat };
      })
      .sort((a, b) => (a.phase === 'Completed') - (b.phase === 'Completed') || (b.entries || 0) - (a.entries || 0));
  }

  // Everyone tracked in one event (flight/day), joined with that event's results
  function eventPlayers(state, kid) {
    const e = state.events[kid]; if (!e) return [];
    const res = new Map(((state.results[e.num] || {}).rows || []).map(([pos, n, cc, prize]) => [n, { pos, prize, cc }]));
    const out = Object.entries(e.p || {}).map(([n, p]) => {
      const seat = e.seats && e.seats[n];
      const r = res.get(n);
      return { name: n, cc: p.cc || (r && r.cc) || '', status: p.st === 's' ? 'seated' : p.st === 'end' ? 'end' : 'busted',
        table: seat ? seat[0] : null, seat: seat ? seat[1] : null, bullets: p.b || 0, carry: !!p.carry,
        firstSeen: p.f, busts: p.x || [], lastBust: (p.x || [])[(p.x || []).length - 1] || null,
        atStart: p.f === e.firstPoll, pos: r ? r.pos : null, prize: r ? r.prize : null };
    });
    // Cashers we never saw seated (e.g. results from before tracking)
    for (const [n, r] of res) if (!e.p[n] && Object.values(state.events).filter((x) => x.num === e.num).every((x) => !x.p || !x.p[n]))
      out.push({ name: n, cc: r.cc, status: 'cashed', table: null, seat: null, bullets: 0, busts: [], lastBust: null, pos: r.pos, prize: r.prize });
    return out;
  }

  function upcoming(state, now, hours) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.phase !== 'Completed' && !e.polls && e.start && e.start > now - 300 && e.start <= now + (hours || 12) * 3600)
      .sort((a, b) => a.start - b.start || a.num - b.num)
      .map((e) => ({ kid: e.kid, num: e.num, name: e.name, start: e.start, buyin: e.buyin, phase: e.phase, sat: e.sat }));
  }

  return { SITE, SERIES, BASE, ACTIVE, activeKids, eventPlayers, upcoming, emptyState, pollOnce, applySnapshot, fetchEventList, mergeList, players, playerTimeline, liveEvents, unflatten, isLaterDay };
});
