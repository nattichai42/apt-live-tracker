/*
 * Royal Poker Tour (royal-poker.com) tracker engine. Shared by the GitHub Actions poller (Node) and the page (browser,
 * read-only: the API doesn't answer other sites' pages, so the browser shows what the poller saved).
 *
 * The site's public API (api.royal-poker.com) lists a festival's events (flights and later days are events of their
 * own, grouped in a "series" per event) and, for each, its standings (one row per player: rank, current seat, busted
 * or not) and payouts. It has no per-player entry counts or bust times. So:
 *   - a finished event read afterwards gives each player one bullet; its entry count says how many re-entries went
 *     unattributed (as for APT series not watched live);
 *   - an event watched live gets them from the changes between polls: a player who comes back with a new seat id has
 *     re-entered, and the poll that first sees a player busted dates the bust.
 * The state has the APT engine's shape, so its counting, timelines and event lists (and the APT page) work on it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../apt/tracker.js'));
  else root.ROPTracker = factory(root.APTTracker);
})(typeof self !== 'undefined' ? self : this, function (APT) {
  'use strict';
  if (!APT) throw new Error('rop.js needs apt/tracker.js loaded first');

  const SITE = 'https://royal-poker.com';
  const API = 'https://api.royal-poker.com/api/v1';
  const BROWSER_POLL = false; // no CORS: pages read the poller's saved state
  const FEED_CAP = 6000;
  const SYNTH = 1000; // events without a number get ours from here; numLabel() hides them
  let SERIES = 'rpt-v-grand-final';
  let SERIES_URL = `${SITE}/series/${SERIES}`;
  const BASE = `${SITE}/event`; // the page links events as BASE + '/' + id

  const nowSec = () => Math.floor(Date.now() / 1000);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sec = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
  // "TRẦN ĐỨC HÙNG" -> "Trần Đức Hùng" (names typed in capitals); mixed case is kept
  const nameCase = (n) => { n = clean(n); return n && n === n.toUpperCase() && /\p{Lu}/u.test(n) ? n.toLocaleLowerCase('vi').replace(/(^|[\s'-])(\p{Ll})/gu, (m, a, b) => a + b.toLocaleUpperCase('vi')) : n; };
  const wordsOf = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');

  function emptyState() {
    return { v: 1, org: 'rop', series: SERIES, updatedAt: 0, listAt: 0, festival: null, events: {}, results: {}, feed: [], aliases: {}, names: {}, people: {} };
  }

  /* ---------- fetching ---------- */
  const THROTTLE = new Set([403, 429, 503]);
  async function get(fetchFn, path, params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    const r = await fetchFn(API + path + q);
    if (!r.ok) { const err = new Error(`HTTP ${r.status} ${path}`); err.status = r.status; err.retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0; throw err; }
    return r.json();
  }
  // Every page of a list endpoint (500 a page at most)
  async function all(fetchFn, path, params) {
    const out = [];
    for (let page = 1; page <= 40; page++) {
      const d = await get(fetchFn, path, { ...params, limit: 500, page });
      out.push(...(d.data || []));
      if (!d.pagination || d.pagination.currentPage >= d.pagination.totalPages) break;
    }
    return out;
  }
  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String((err && err.message) || err), status: err && err.status, retryAfter: err && err.retryAfter }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }
  // The festivals (the API's "series groups"): { slug, publicId, name, start, end, status }
  async function festivals(fetchFn) {
    const d = await get(fetchFn, '/public/series-groups');
    return (d.data || d || []).map((g) => ({ slug: g.slug, publicId: g.publicId, name: clean(g.name), start: String(g.startDate || '').slice(0, 10), end: String(g.endDate || '').slice(0, 10),
      status: g.effectiveStatus || g.status, done: (g.effectiveStatus || g.status) === 'completed' }));
  }

  /* ---------- event metadata ---------- */
  const DONE = /^(completed|closed|done|ended|finished|cancelled)$/, LIVE = /^(active|in_progress|live|running|starting)$/;
  function phaseOf(e, t, now) {
    const st = String(t.status || '').toLowerCase();
    if (DONE.test(st)) return 'Completed';
    if (st === 'paused') return e.start && e.start <= now ? 'Break' : 'Scheduled';
    if (LIVE.test(st)) {
      if (e.regClose && e.regClose > now) return 'Late Reg';
      if (e.remaining != null && e.paidPlaces && e.remaining <= e.paidPlaces) return e.remaining <= 9 ? 'Final Table' : 'In The Money';
      return 'Running';
    }
    if (st === 'registering') return 'Reg Open';
    return 'Scheduled';
  }
  function mergeMeta(e, t, now) {
    e.title = clean(t.name);
    e.name = e.title.replace(/^#\d+\s*-\s*/, '');
    e.number = (e.title.match(/^#(\d+)\b/) || [])[1] || null;
    // An event's flights and days share its series; other events in one series (e.g. a festival's satellites) don't
    e.group = t.seriesPublicId && (t.isFlight || /\b(DAY \d|FLIGHT|FINAL DAY|FINAL TABLE)\b/i.test(e.title)) ? t.seriesPublicId : null;
    e.start = sec(t.startTime) || e.start || null;
    e.end = sec(t.endTime) || null;
    e.regClose = sec(t.regCloseAt) || null;
    e.buyin = Math.round((Number(t.buyIn) || 0) + (Number(t.fee) || 0));
    e.currency = /^[A-Z]{3}$/.test(t.buyInCurrency || '') ? t.buyInCurrency : /^[A-Z]{3}$/.test(t.currency || '') ? t.currency : 'VND';
    e.prizePool = Math.round(Number(t.prizepool) || 0);
    // (a finished event showing 0 entries didn't report them: unknown, not none)
    if (t.totalEntry != null) e.entries = Number(t.totalEntry) || (DONE.test(String(t.status || '')) ? null : 0);
    // A later day's own count is the players who reached it; the APT engine expects the whole event's there
    if (APT.isLaterDay(e.name) && Number(t.flightGroupEntries) > 0) e.entries = Number(t.flightGroupEntries);
    const left = t.playersRemaining ?? t.entryRemaining;
    if (left != null && !DONE.test(String(t.status || ''))) e.remaining = Number(left);
    e.sat = t.eventType === 'satellite' || /satellite/i.test(e.title) || /^S\d+\b/.test(e.title);
    e.status = t.status;
    e.phase = phaseOf(e, t, now);
  }
  async function mergeList(state, fetchFn, now) {
    let g = state.festival;
    if (!g || !g.publicId) {
      g = (await festivals(fetchFn)).find((x) => x.slug === SERIES);
      if (!g) throw new Error(`no festival "${SERIES}"`);
    }
    const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const list = (await all(fetchFn, '/public/events', { startDateFrom: shift(g.start, -2), startDateTo: shift(g.end, 2) }))
      .filter((t) => t && t.publicId && (t.seriesGroupPublicId === g.publicId || clean(t.seriesGroupName) === g.name));
    state.festival = { ...g, timezone: 'Asia/Ho_Chi_Minh', currency: (list.find((t) => t.buyInCurrency) || {}).buyInCurrency || 'VND' };
    const ids = new Set();
    for (const t of list) {
      ids.add(t.publicId);
      const e = state.events[t.publicId] || (state.events[t.publicId] = { kid: t.publicId, p: {}, polls: 0 });
      mergeMeta(e, t, now);
    }
    for (const k of Object.keys(state.events)) if (!ids.has(k)) delete state.events[k];
    state.listAt = now;
  }

  // One look at an event's standings: who is in, where, busted or not. Watched live, the changes since the last look
  // are re-entries (a new seat) and busts (newly busted), at this poll's time.
  function mergeStandings(state, e, rows, now) {
    const first = !e.firstPoll;
    if (first) { e.firstPoll = now; if (e.phase === 'Completed') e.backfilled = 1; }
    e.track = e.track || {};
    const live = !e.backfilled;
    for (const r of rows) {
      const pid = r.playerPublicId; if (!pid) continue;
      state.people[pid] = [nameCase(r.playerName) || 'Unknown', String(r.country || '').toUpperCase()];
      let t = e.track[pid];
      // (a finished event marks everyone busted, its winner too)
      const busted = !!r.isBusted && !(e.phase === 'Completed' && r.rank === 1);
      if (!t) {
        t = e.track[pid] = { s: [r.seatPublicId], f: first ? (e.start || now) : now, x: [], r: [], out: busted };
        if (!first) pushFeed(state, { t: now, kid: e.kid, pid, k: 'entry', b: 1 });
        if (busted && live && !first) { t.x.push(now); pushFeed(state, { t: now, kid: e.kid, pid, k: 'bust', b: 1 }); }
      } else {
        if (r.seatPublicId && !t.s.includes(r.seatPublicId)) {
          // A new seat: a re-entry (busted since the last look, if we didn't see it)
          if (!t.out && live) { t.x.push(now); pushFeed(state, { t: now, kid: e.kid, pid, k: 'bust', b: t.s.length }); }
          t.s.push(r.seatPublicId);
          if (live) { t.r.push(now); pushFeed(state, { t: now, kid: e.kid, pid, k: 'reentry', b: t.s.length }); }
          t.out = false;
        }
        if (busted && !t.out) { t.out = true; if (live) { t.x.push(now); pushFeed(state, { t: now, kid: e.kid, pid, k: 'bust', b: t.s.length }); } }
        else if (!busted) t.out = false;
      }
      t.seat = busted ? null : [r.tableNumber ?? null, r.seatNumber ?? null]; t.stack = busted ? 0 : Number(r.stack) || 0; t.rank = r.rank;
    }
    // A finished event read afterwards ended at its end time, not when we read it
    e.lastPoll = e.backfilled ? (e.end || e.start || now) : now; e.polls = (e.polls || 0) + 1;
    if (e.phase === 'Completed' && !e.doneAt) e.doneAt = now;
  }
  function pushFeed(state, item) {
    (state.rawFeed || (state.rawFeed = [])).push(item);
    if (state.rawFeed.length > FEED_CAP) state.rawFeed.splice(0, state.rawFeed.length - FEED_CAP);
  }
  function mergePayouts(state, e, d) {
    e.pay = [];
    for (const band of d.payouts || []) for (const w of band.winners || []) {
      if (!w.playerPublicId) continue;
      state.people[w.playerPublicId] = state.people[w.playerPublicId] || [nameCase(w.playerName) || 'Unknown', String(w.playerCountry || '').toUpperCase()];
      e.pay.push([Number(w.rank), w.playerPublicId, Math.round(Number(w.amount) || 0)]);
    }
    e.pay.sort((a, b) => a[0] - b[0]);
    e.paidPlaces = Math.max(e.pay.length, ...(d.payouts || []).map((b) => Number(b.slotCount) || 0).concat(0));
  }

  /* ---------- the APT-shaped state ---------- */
  // Same name and country, never in one event together: one player (a second profile); else "Name (2)"
  function nameKeys(state) {
    const where = new Map();
    for (const e of Object.values(state.events)) for (const pid of Object.keys(e.track || {})) { if (!where.has(pid)) where.set(pid, new Set()); where.get(pid).add(e.kid); }
    for (const e of Object.values(state.events)) for (const r of e.pay || []) if (!where.has(r[1])) where.set(r[1], new Set());
    const first = (pid) => Math.min(Infinity, ...[...where.get(pid)].map((k) => state.events[k].start || 0));
    const byName = new Map();
    for (const pid of [...where.keys()].sort((a, b) => first(a) - first(b) || (a < b ? -1 : 1))) {
      const k = ((state.people[pid] || ['Unknown'])[0]).toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(pid);
    }
    const names = {}, used = new Set();
    for (const pids of byName.values()) {
      const groups = [];
      for (const pid of pids) {
        const kids = where.get(pid), cc = (state.people[pid] || [])[1] || '';
        const g = groups.find((x) => (!x.cc || !cc || x.cc === cc) && ![...kids].some((k) => x.kids.has(k)));
        if (g) { g.pids.push(pid); kids.forEach((k) => g.kids.add(k)); g.cc = g.cc || cc; } else groups.push({ pids: [pid], kids: new Set(kids), cc });
      }
      const name = (state.people[pids[0]] || ['Unknown'])[0];
      for (const g of groups) { let key = name, i = 2; while (used.has(key)) key = `${name} (${i++})`; used.add(key); for (const pid of g.pids) names[pid] = key; }
    }
    state.names = names;
  }
  const keyOf = (state, pid) => state.names[pid] || (state.people[pid] || ['Unknown'])[0];

  function build(state, now) {
    nameKeys(state);
    // Numbers: from the name ("#30 - ..."), shared by the event's flights and days; ours for the rest
    const all = Object.values(state.events).sort((a, b) => (a.start || 0) - (b.start || 0) || (a.kid < b.kid ? -1 : 1));
    const groupNum = new Map();
    for (const e of all) if (e.number && e.group && !groupNum.has(e.group)) groupNum.set(e.group, Number(e.number));
    const synth = new Map(); let next = SYNTH + 1;
    for (const e of all) {
      if (e.number) { e.num = Number(e.number); continue; }
      const k = e.group || 'kid:' + e.kid;
      if (groupNum.has(k)) { e.num = groupNum.get(k); continue; }
      if (!synth.has(k)) synth.set(k, next++);
      e.num = synth.get(k);
    }
    const byNum = new Map();
    for (const e of all) { if (!byNum.has(e.num)) byNum.set(e.num, []); byNum.get(e.num).push(e); }
    const results = {};
    for (const [num, kids] of byNum) {
      // Flights first, then later days: a player already seen in an earlier part of the event is carried over
      const order = kids.slice().sort((a, b) => APT.isLaterDay(a.name) - APT.isLaterDay(b.name) || (a.start || 0) - (b.start || 0));
      const seen = new Set();
      for (const e of order) {
        e.p = {}; e.seats = {};
        let alive = 0;
        for (const [pid, t] of Object.entries(e.track || {})) {
          const k = keyOf(state, pid), cc = (state.people[pid] || [])[1] || '';
          const carried = APT.isLaterDay(e.name) && seen.has(pid);
          seen.add(pid);
          const p = { b: carried ? 0 : t.s.length, st: t.out ? 'x' : e.phase === 'Completed' ? 'end' : 's', f: t.f, x: t.x.slice(), cc };
          if (carried) { p.carry = 1; p.b = Math.max(0, t.s.length - 1); } // a new seat on a later day is a new bullet
          if (t.r.length) p.r = t.r.slice(-Math.max(0, p.b - 1));
          if (!t.out && e.phase !== 'Completed') { alive++; if (t.seat) e.seats[k] = [t.seat[0], t.seat[1], cc]; p.chips = t.stack; }
          e.p[k] = p;
        }
        e.seated = e.phase === 'Completed' ? 0 : alive;
      }
      // Results: the last part's places (a final day ranks everyone who reached it), plus cashes from other parts by
      // players it doesn't list (busted in the money in a flight)
      // The latest part paying out first (a final day's amounts replace a flight's for the same player)
      const parts = kids.filter((e) => e.pay && e.pay.length).sort((a, b) => APT.isLaterDay(b.name) - APT.isLaterDay(a.name) || (b.start || 0) - (a.start || 0));
      // Older events (RPT Championship III) give amounts in thousands of VND: a first prize below the buy-in, or a prize
      // pool below it, can only be that
      const buyin = Math.max(0, ...kids.map((e) => e.buyin || 0));
      const scale = buyin && Math.max(0, ...parts.flatMap((e) => e.pay.map((r) => r[2]))) * 1.5 < buyin ? 1000 : 1;
      for (const e of kids) if (e.prizePool && buyin && e.prizePool < buyin) e.prizePool *= 1000;
      if (parts.length) {
        const rows = parts[0].pay.filter((r) => r[2] > 0).map(([pos, pid, prize]) => [pos, pid, prize * scale]);
        const have = new Set(rows.map((r) => r[1]));
        const extra = parts.slice(1).flatMap((e) => e.pay).filter((r) => r[2] > 0 && !have.has(r[1]) && (have.add(r[1]), true)).map(([pos, pid, prize]) => [pos, pid, prize * scale]).sort((a, b) => b[2] - a[2]);
        let pos = Math.max(0, ...rows.map((r) => r[0]));
        for (const [, pid, prize] of extra) rows.push([++pos, pid, prize]);
        if (rows.length) results[num] = { at: Math.max(...kids.map((e) => e.lastPoll || 0)) || now, rows: rows.map(([pos, pid, prize]) => [pos, keyOf(state, pid), (state.people[pid] || [])[1] || '', prize]),
          final: kids.every((e) => e.phase === 'Completed') };
      }
    }
    state.results = results;
    state.feed = (state.rawFeed || []).map((f) => { const e = state.events[f.kid]; return e ? { t: f.t, kid: f.kid, num: e.num, n: keyOf(state, f.pid), k: f.k, b: f.b, cc: (state.people[f.pid] || [])[1] || '' } : null; })
      .filter(Boolean).sort((a, b) => a.t - b.t);
    return state;
  }

  // Being played, about to start, or finished within the last 2 hours (payouts still settling); finished events never
  // read are read once
  function activeKids(state, now) {
    return Object.values(state.events).filter((e) => {
      if (e.closed) return false;
      if (e.phase === 'Completed') return !e.polls || now - (e.doneAt || now) < 7200;
      return APT.ACTIVE.has(e.phase) && e.start && e.start <= now + 600;
    }).map((e) => e.kid);
  }

  /** One polling round. opts: { fetchFn, listEvery (s), resultsEvery (s), concurrency } */
  async function pollOnce(state, opts = {}) {
    const baseFetch = opts.fetchFn || ((u, o) => fetch(u, { ...o, cache: 'no-store' }));
    const now = nowSec();
    const summary = { at: now, events: 0, busts: 0, reentries: 0, entries: 0, errors: [], requests: 0, throttled: 0, retryAfter: 0 };
    const fetchFn = (u, o) => { summary.requests++; return baseFetch(u, o); };
    const note = (err) => {
      summary.errors.push(err.error || err.message || String(err));
      if (THROTTLE.has(err.status)) { summary.throttled++; summary.retryAfter = Math.max(summary.retryAfter, err.retryAfter || 0); }
    };
    Object.assign(state, { names: state.names || {}, people: state.people || {}, aliases: state.aliases || {} });
    if (!state.listAt || now - state.listAt >= (opts.listEvery || 120) || !Object.keys(state.events).length) {
      try { await mergeList(state, fetchFn, now); } catch (err) { note({ error: 'events: ' + err.message, status: err.status, retryAfter: err.retryAfter }); }
    }
    const before = (state.rawFeed || []).length;
    const kids = activeKids(state, now);
    const got = await pool(kids, opts.concurrency || 3, async (kid) => ({ kid, rows: await all(fetchFn, `/public/events/${kid}/standings`, {}) }));
    for (const g of got) {
      if (!g || g.error) { note(g || { error: 'unknown' }); continue; }
      const e = state.events[g.kid]; if (!e) continue;
      mergeStandings(state, e, g.rows, now); summary.events++;
    }
    // Payouts: once for a finished event read late, every resultsEvery while one is played or settling
    // (and at once when an event has just finished)
    const want = Object.values(state.events).filter((e) => e.polls && !e.closed && (!e.payAt || (e.phase === 'Completed' && e.payPhase !== 'Completed') ||
      (kids.includes(e.kid) && now - e.payAt >= (opts.resultsEvery || 120))));
    const rs = await pool(want, opts.concurrency || 3, async (e) => { mergePayouts(state, e, await get(fetchFn, `/public/events/${e.kid}/payouts`)); e.payAt = now; e.payPhase = e.phase; });
    for (const r of rs) if (r && r.error) note(r);
    for (const e of Object.values(state.events)) if (e.phase === 'Completed' && e.payAt && e.doneAt && now - e.doneAt >= 7200) e.closed = 1;
    build(state, now);
    for (const f of (state.rawFeed || []).slice(before)) { if (f.k === 'bust') summary.busts++; else if (f.k === 'reentry') summary.reentries++; else summary.entries++; }
    state.updatedAt = now;
    return summary;
  }

  function repair(state) {
    if (state && state.events && Object.values(state.events).some((e) => e.track)) build(state, nowSec());
    return 0;
  }
  // A finished festival as a small file: what was read, as the APT-shaped records (no raw tracks or payouts)
  function slim(state) {
    const out = { v: 1, org: 'rop', series: state.series, archive: true, festival: state.festival, updatedAt: state.updatedAt, events: {}, results: {}, feed: state.feed || [], aliases: state.aliases || {} };
    for (const e of Object.values(state.events)) {
      // Events with nothing on record (never played, or the schedule's empty copies of real events) are left out
      if (!Object.keys(e.p || {}).length && !(e.entries > 0) && !(e.pay && e.pay.length)) continue;
      const { track, pay, payAt, payPhase, seats, polls, closed, doneAt, title, number, group, paidPlaces, status, backfilled, ...keep } = e;
      const p = {};
      for (const [k, x] of Object.entries(e.p || {})) { const { chips, ...rest } = x; p[k] = rest; }
      out.events[e.kid] = { ...keep, p, polls: polls ? 1 : 0, phase: 'Completed' };
    }
    for (const [k, r] of Object.entries(state.results || {})) out.results[k] = { ...r, final: true };
    return out;
  }
  const numLabel = (n) => (Number(n) > SYNTH ? '' : '#' + n);
  // Finished festivals, for tools/series-archive.js: [{ slug, name }]
  const finished = async (fetchFn) => (await festivals(fetchFn)).filter((g) => g.done && g.slug).map((g) => ({ slug: g.slug, name: g.name }));

  const shared = ['players', 'playerTimeline', 'liveEvents', 'eventPlayers', 'completedEvents', 'upcoming', 'watchedFromStart', 'eventFinished',
    'isLaterDay', 'baseName', 'canon', 'similarNames', 'ACTIVE'];
  const api = { SITE, API, BASE, SERIES, SERIES_URL, BROWSER_POLL, emptyState, pollOnce, repair, build, slim, numLabel, festivals, finished, nameCase, wordsOf,
    pack: (s) => s, unpack: (s) => s };
  for (const k of shared) api[k] = APT[k];
  // source: the series' entry in docs/series.js ({ series: '<festival slug, as in the API's series groups>' })
  api.configure = (source) => {
    if (source && source.series) { SERIES = source.series; SERIES_URL = `${SITE}/series/${SERIES}`; }
    Object.assign(api, { SERIES, SERIES_URL });
    return api;
  };
  return api;
});
