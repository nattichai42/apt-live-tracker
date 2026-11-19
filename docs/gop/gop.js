/*
 * Gods of Poker (godsofpoker.com) tracker engine. Shared by the GitHub Actions poller (Node) and the page (browser,
 * read-only: the site doesn't answer other sites' pages, so the browser shows what the poller saved).
 *
 * GOP runs on the same tournament software as APT (flights and later days are events of their own under one event
 * number), but its pages publish complete records: every bullet is a row with its purchase, every bust has its time
 * and every player an id. So nothing is inferred from seat changes: each poll stores the rows of the events it read
 * and rebuilds the whole state from them, in the APT engine's shape, and the APT engine's counting, timelines and
 * event lists (and the APT page) work on it unchanged.
 *
 * A bullet is a purchase (subscription): it is counted in the first flight it appears in, and a later day or an
 * "ITM holding" table showing the same purchase holds a player carried over, not a new entry. Purchases add up to the
 * official entries exactly (556 of 556 in the Taipei 2026 Main Event's 12 parts).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../apt/tracker.js'));
  else root.GOPTracker = factory(root.APTTracker);
})(typeof self !== 'undefined' ? self : this, function (APT) {
  'use strict';
  if (!APT) throw new Error('gop.js needs apt/tracker.js loaded first');

  const SITE = 'https://godsofpoker.com';
  const BROWSER_POLL = false; // no CORS: pages read the poller's saved state
  const FEED_CAP = 6000;
  let SERIES = 'taipei-2027';
  let SERIES_URL = `${SITE}/series/${SERIES}`;
  // Event pages are /event/<id> (the page builds links as BASE + '/' + id)
  const BASE = `${SITE}/event`;
  const SYNTH = 1000; // unnumbered events (satellites, side events) get numbers from here; numLabel() hides them

  const nowSec = () => Math.floor(Date.now() / 1000);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sec = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
  // "2026-01-16T12:30:00" at the venue -> epoch seconds
  function zoned(local, tz) {
    if (!local) return null;
    const m = String(local).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/); if (!m) return sec(local);
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    const off = (t) => {
      try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
          .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
      } catch { return 0; }
    };
    let t = guess - off(guess); t = guess - off(t);
    return Math.floor(t / 1000);
  }

  function emptyState() {
    return { v: 1, org: 'gop', series: SERIES, updatedAt: 0, listAt: 0, festival: null, events: {}, results: {}, feed: [], aliases: {}, names: {}, people: {} };
  }

  /* ---------- fetching ---------- */
  const THROTTLE = new Set([403, 429, 503]);
  // A SvelteKit page's data: its nodes unflattened and merged (node 0 is the site's layout)
  async function getData(fetchFn, url) {
    const r = await fetchFn(url);
    if (!r.ok) { const err = new Error(`HTTP ${r.status} ${url.replace(SITE, '')}`); err.status = r.status; err.retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0; throw err; }
    const d = await r.json();
    const out = {};
    (d.nodes || []).forEach((n, i) => { if (i > 0 && n && n.data) Object.assign(out, APT.unflatten(n.data)); });
    return out;
  }
  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String((err && err.message) || err), status: err && err.status, retryAfter: err && err.retryAfter }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  /* ---------- event metadata ---------- */
  const CUR = { 'NT$': 'TWD', '₩': 'KRW', '$': 'USD', '₱': 'PHP', 'HK$': 'HKD', '¥': 'JPY', 'S$': 'SGD', 'RM': 'MYR', '฿': 'THB', '₫': 'VND', '€': 'EUR' };
  const curOf = (t, fest) => (/^[A-Z]{3}$/.test(t.seriesCurrency || '') ? t.seriesCurrency : CUR[t.currency] || (fest && fest.currency) || 'USD');
  const isHolding = (title) => /ITM HOLDING|\(Flight \w+ - ITM\)/i.test(title || '');
  // Holding tables are later days too (players already in the money, carried over): APT's isLaterDay() knows the name
  const nameOf = (t) => { const n = clean(t.title); return isHolding(n) && !/ITM Holding/i.test(n) ? n + ' - ITM Holding' : n; };

  // Phase in the APT engine's words, from GOP's status and counts
  function phaseOf(e, t, now) {
    const code = String((t.phase && t.phase.code) || '').toLowerCase(), st = t.status || {};
    if (/champion|conclud|complet|finish|cancel/.test(code)) return 'Completed';
    if (st.gameInProgress) {
      if (st.paused) return 'Break';
      if (e.regClose && e.regClose > now) return 'Late Reg';
      if (e.paidPlaces && e.remaining != null && e.remaining <= e.paidPlaces) return e.remaining <= 9 ? 'Final Table' : 'In The Money';
      return 'Running';
    }
    if (e.start && e.start <= now && st.paused && /open|run|progress/i.test(st.code || '')) return 'Paused';
    if (e.regOpen && e.regOpen <= now && e.start && e.start > now - 6 * 3600) return 'Reg Open';
    return 'Scheduled';
  }

  function mergeMeta(e, t, fest, now) {
    const tz = t.timezone || (fest && fest.timezone) || 'UTC';
    e.title = clean(t.title); e.name = nameOf(t);
    e.number = String(t.eventNumber || '0');
    e.start = zoned(t.startTime, tz) || e.start || null;
    e.regOpen = zoned(t.regOpen, tz); e.regClose = zoned(t.regClose, tz);
    e.buyin = Math.round(Number(t.totalBuyin) || 0);
    e.currency = curOf(t, fest);
    e.prizePool = Math.round(Number(t.totalPrizePool) || 0);
    e.paidPlaces = Number(t.totalPayouts) || 0;
    if (t.totalEntries != null) e.entries = Number(t.totalEntries);
    if (t.totalPlayers != null) e.remaining = Number(t.totalPlayers);
    e.sat = /satellite|\bseats?\b/i.test(e.title);
    e.single = !!t.isSingleDay;
    e.gopPhase = (t.phase && t.phase.code) || '';
    e.phase = phaseOf(e, t, now);
  }

  function mergeList(state, d, now) {
    const f = d.festival || d.series || {};
    state.festival = { title: clean(f.title), slug: f.slug, start: f.start_date, dates: f.date, timezone: f.timezone, currency: f.currency, complete: !!f.isComplete, events: f.total_events };
    // Not the summaries (an event's totals over its flights) nor GOP's leftovers marked "DO NOT USE" (a duplicate of a
    // real flight, which would otherwise take that flight's bullets)
    const listed = (((d.events || {}).events) || []).filter((t) => t && t.kholdem_id && !t.isSummary && !/do not use/i.test(t.title || ''));
    for (const t of listed) {
      const e = state.events[t.kholdem_id] || (state.events[t.kholdem_id] = { kid: t.kholdem_id, p: {}, polls: 0 });
      mergeMeta(e, t, state.festival, now);
    }
    // Events the site no longer lists (cancelled, merged): drop
    const ids = new Set(listed.map((t) => t.kholdem_id));
    for (const k of Object.keys(state.events)) if (!ids.has(k)) delete state.events[k];
    state.listAt = now;
  }

  // One event's page: its rows (one per bullet, carried-over players included) and its payouts, compact
  function mergeEvent(state, e, t, now) {
    mergeMeta(e, t, state.festival, now);
    const rows = [];
    for (const r of t.players || []) {
      const pl = r.player || {}, sub = r.subscription || {};
      if (!pl.id) continue;
      const name = clean(pl.description || [pl.firstname, pl.lastname].filter(Boolean).join(' ')) || 'Unknown';
      const cc = String(r.countryCode || '').toUpperCase();
      state.people[pl.id] = [name, cc];
      rows.push([pl.id, sub.referenceId || r.id, sec(sub.date) || e.start || now, r.busted ? (sec(r.elimination && r.elimination.date) || -1) : 0,
        r.busted ? null : r.tableIndex ?? null, r.busted ? null : r.seatIndex ?? null, r.busted ? 0 : Number(r.chipsCount) || 0]);
    }
    e.q = rows;
    e.pay = (t.payouts || []).filter((p) => p && p.position != null).map((p) => {
      const w = p.winner || {}, pl = w.player || {};
      const name = pl.id ? clean(pl.description || [pl.firstname, pl.lastname].filter(Boolean).join(' ')) : null;
      if (pl.id) state.people[pl.id] = state.people[pl.id] || [name, String(w.countryCode || '').toUpperCase()];
      return [Number(p.position), pl.id || null, Math.round((Number(p.payoutAmount ?? p.amount) || 0) + (Number(p.bountyAmount) || 0))];
    }).sort((a, b) => a[0] - b[0]);
    if (!e.firstPoll) e.firstPoll = Math.min(now, e.start || now); // the records are complete from the first look
    e.lastPoll = now; e.polls = (e.polls || 0) + 1;
    if (e.phase === 'Completed' && !e.doneAt) e.doneAt = now;
  }

  /* ---------- the APT-shaped state, rebuilt from the stored rows ---------- */
  // A name's words in any order, without accents or case ("Wang Shi Rong" = "Shi Rong Wang")
  const wordsOf = (n) => String(n).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');
  // A player's key: their name, or "Name (2)" for a second player id with the same name in this series
  function keyOf(state, pid) {
    if (state.names[pid]) return state.names[pid];
    const [name] = state.people[pid] || ['Unknown'];
    const used = new Set(Object.values(state.names));
    let k = name, i = 2; while (used.has(k)) k = `${name} (${i++})`;
    return (state.names[pid] = k);
  }

  // Profiles with the same name are one player (GOP keeps duplicate profiles: one plays, another is paid) unless they
  // played in one event together or their countries disagree; such a second player is "Name (2)"
  function nameKeys(state) {
    const where = new Map();
    for (const e of Object.values(state.events)) for (const r of e.q || []) { if (!where.has(r[0])) where.set(r[0], new Set()); where.get(r[0]).add(e.kid); }
    const byName = new Map();
    for (const pid of [...where.keys()].sort((a, b) => Math.min(...[...where.get(a)].map((k) => state.events[k].start || 0)) - Math.min(...[...where.get(b)].map((k) => state.events[k].start || 0)) || (a < b ? -1 : 1))) {
      const name = (state.people[pid] || ['Unknown'])[0], k = name.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(pid);
    }
    const names = {}, used = new Set();
    for (const pids of byName.values()) {
      const groups = []; // [{ pids, kids, cc, key }]
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

  function build(state, now) {
    nameKeys(state);
    // Event numbers: GOP's own, else one of ours: an unnumbered event's flights and later days share one (by its name
    // without the flight or day), but same-named side events on different days are events of their own
    const synth = new Map(); let next = SYNTH + 1;
    const all = Object.values(state.events).sort((a, b) => (a.start || 0) - (b.start || 0) || (a.kid < b.kid ? -1 : 1));
    for (const e of all) {
      const n = Number(e.number);
      if (n > 0) { e.num = n; continue; }
      const parted = /\bFlight \w+\b/i.test(e.name) || APT.isLaterDay(e.name);
      const key = parted ? APT.baseName(e.name) : 'kid:' + e.kid;
      if (!synth.has(key)) synth.set(key, next++);
      e.num = synth.get(key);
    }
    const byNum = new Map();
    for (const e of all) { if (!byNum.has(e.num)) byNum.set(e.num, []); byNum.get(e.num).push(e); }
    const results = {}, feed = [];
    for (const [num, kids] of byNum) {
      // Flights first (a holding table can open before the flight it holds), then later days
      const order = kids.slice().sort((a, b) => APT.isLaterDay(a.name) - APT.isLaterDay(b.name) || (a.start || 0) - (b.start || 0));
      const seen = new Set();
      for (const e of order) {
        e.p = {}; e.seats = {};
        if (!e.q) continue;
        const by = new Map();
        for (const row of e.q) { if (!by.has(row[0])) by.set(row[0], []); by.get(row[0]).push(row); }
        let alive = 0;
        for (const [pid, rows] of by) {
          rows.sort((a, b) => a[2] - b[2]);
          const fresh = rows.filter((r) => !seen.has(r[1]));
          fresh.forEach((r) => seen.add(r[1]));
          const k = keyOf(state, pid), cc = (state.people[pid] || [])[1] || '';
          const x = rows.filter((r) => r[3] > 0).map((r) => r[3]).sort((a, b) => a - b);
          const live = rows.find((r) => !r[3]);
          const p = { id: pid, b: fresh.length, st: live ? (e.phase === 'Completed' ? 'end' : 's') : 'x', f: fresh.length ? fresh[0][2] : (e.start || rows[0][2]), x, cc };
          if (!fresh.length) p.carry = 1;
          if (fresh.length > 1) p.r = fresh.slice(1).map((r) => r[2]);
          if (live && e.phase !== 'Completed') { alive++; p.chips = live[6]; if (live[4] != null) e.seats[k] = [live[4], live[5], cc]; }
          e.p[k] = p;
          // Feed: entries, re-entries and busts at the times on record
          fresh.forEach((r, i) => feed.push({ t: r[2], kid: e.kid, num, n: k, k: i ? 'reentry' : 'entry', b: i + 1, cc }));
          x.forEach((t, i) => feed.push({ t, kid: e.kid, num, n: k, k: 'bust', b: p.carry ? 1 : Math.min(i + 1, fresh.length || 1), cc }));
        }
        e.seated = e.phase === 'Completed' ? 0 : alive;
        if (e.phase === 'Completed') { const last = Math.max(0, ...e.q.map((r) => r[3])); e.lastPoll = Math.max(last, e.start || 0) || e.lastPoll; }
      }
      // Payouts: the part listing the most paid winners (the last day lists every place, flights' early cashes included).
      // GOP sometimes pays a second profile of an entrant (same name, maybe in another word order): credit the entrant
      const src = kids.filter((e) => e.pay && e.pay.length).sort((a, b) => b.pay.filter((r) => r[1]).length - a.pay.filter((r) => r[1]).length)[0];
      if (src) {
        const entrants = new Set(kids.flatMap((e) => (e.q || []).map((r) => r[0])));
        const byName = new Map();
        for (const pid of entrants) { const k = wordsOf((state.people[pid] || [''])[0]); byName.set(k, byName.has(k) ? null : pid); }
        const payee = (pid) => {
          if (entrants.has(pid) || !entrants.size) return pid;
          const twin = byName.get(wordsOf((state.people[pid] || [''])[0]));
          if (twin) { state.names[pid] = keyOf(state, twin); return twin; }
          return pid;
        };
        const rows = src.pay.filter((r) => r[1] && r[2] > 0).map(([pos, pid0, prize]) => { const pid = payee(pid0); return [pos, keyOf(state, pid), (state.people[pid] || [])[1] || '', prize]; });
        if (rows.length) results[num] = { at: src.lastPoll || now, rows, final: kids.every((e) => e.phase === 'Completed') && rows.length >= src.pay.length };
      }
    }
    state.results = results;
    feed.sort((a, b) => a.t - b.t);
    state.feed = feed.slice(-FEED_CAP);
    return state;
  }

  // Being played, about to start, or finished within the last 2 hours (payouts still settling)
  function activeKids(state, now) {
    return Object.values(state.events).filter((e) => {
      if (e.closed) return false;
      if (e.phase === 'Completed') return !e.q || now - (e.doneAt || now) < 7200;
      return APT.ACTIVE.has(e.phase) && e.start && e.start <= now + 600;
    }).map((e) => e.kid);
  }

  /**
   * One polling round. opts: { fetchFn, listEvery (s), concurrency, backfill (default true: read every finished event
   * not read yet, once) }. Returns a summary.
   */
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
      try { mergeList(state, await getData(fetchFn, `${SITE}/series/${SERIES}/__data.json`), now); }
      catch (err) { note({ error: 'series: ' + err.message, status: err.status, retryAfter: err.retryAfter }); }
    }
    const before = { busts: state.feed.filter((f) => f.k === 'bust').length, re: state.feed.filter((f) => f.k === 'reentry').length, en: state.feed.filter((f) => f.k === 'entry').length };
    const kids = activeKids(state, now);
    const got = await pool(kids, opts.concurrency || 3, async (kid) => ({ kid, t: (await getData(fetchFn, `${BASE}/${kid}/__data.json`)).event }));
    for (const g of got) {
      if (!g || g.error) { note(g || { error: 'unknown' }); continue; }
      const t = g.t && (g.t.event || g.t); const e = state.events[g.kid];
      if (!t || !e) continue;
      mergeEvent(state, e, t, now); summary.events++;
    }
    for (const e of Object.values(state.events)) if (e.phase === 'Completed' && e.q && e.doneAt && now - e.doneAt >= 7200) e.closed = 1;
    build(state, now);
    const after = (k) => state.feed.filter((f) => f.k === k).length;
    summary.busts = Math.max(0, after('bust') - before.busts); summary.reentries = Math.max(0, after('reentry') - before.re); summary.entries = Math.max(0, after('entry') - before.en);
    state.updatedAt = now;
    return summary;
  }

  // Saved states: a rebuilt feed if it was left out (archives), and currency codes
  function repair(state) {
    if (!state || !state.events) return 0;
    if ((!state.feed || !state.feed.length) && Object.values(state.events).some((e) => e.q)) build(state, nowSec());
    else if (!state.feed || !state.feed.length) state.feed = feedOf(state);
    return 0;
  }
  // The feed from a slimmed archive (no rows kept): entries, re-entries and busts from each player's record
  function feedOf(state) {
    const feed = [];
    for (const e of Object.values(state.events)) for (const [n, p] of Object.entries(e.p || {})) {
      if (p.b) { feed.push({ t: p.f, kid: e.kid, num: e.num, n, k: 'entry', b: 1, cc: p.cc }); (p.r || []).forEach((t, i) => feed.push({ t, kid: e.kid, num: e.num, n, k: 'reentry', b: i + 2, cc: p.cc })); }
      (p.x || []).forEach((t, i) => feed.push({ t, kid: e.kid, num: e.num, n, k: 'bust', b: i + 1, cc: p.cc }));
    }
    return feed.sort((a, b) => a.t - b.t).slice(-FEED_CAP);
  }
  // A finished series as a small file: the rows and payouts it was built from, and the feed, are left out
  function slim(state) {
    const out = { v: 1, org: 'gop', series: state.series, archive: true, festival: state.festival, updatedAt: state.updatedAt, events: {}, results: {}, feed: [], aliases: state.aliases || {} };
    for (const e of Object.values(state.events)) {
      const { q, pay, seats, polls, closed, doneAt, regOpen, gopPhase, title, number, paidPlaces, chips, ...keep } = e;
      const p = {};
      for (const [k, x] of Object.entries(e.p || {})) { const { id, chips: c, ...rest } = x; p[k] = rest; }
      out.events[e.kid] = { ...keep, p, polls: polls ? 1 : 0, phase: 'Completed' }; // the series is over (a part never played reads as paused)
    }
    for (const [k, r] of Object.entries(state.results || {})) out.results[k] = { ...r, final: true };
    return out;
  }
  const numLabel = (n) => (Number(n) > SYNTH ? '' : '#' + n);
  // Finished series, for tools/series-archive.js: [{ slug, name }]
  const finished = async (fetchFn) => (((await getData(fetchFn, `${SITE}/series/__data.json`)).festivals) || [])
    .filter((f) => f.isComplete && f.production !== false).map((f) => ({ slug: f.slug, name: clean(f.title) }));

  const shared = ['players', 'playerTimeline', 'liveEvents', 'eventPlayers', 'completedEvents', 'upcoming', 'watchedFromStart', 'eventFinished',
    'isLaterDay', 'baseName', 'canon', 'similarNames', 'unflatten', 'ACTIVE'];
  const api = { SITE, BASE, SERIES, SERIES_URL, BROWSER_POLL, emptyState, pollOnce, repair, build, slim, numLabel, zoned, getData, finished,
    pack: (s) => s, unpack: (s) => s };
  for (const k of shared) api[k] = APT[k];
  // source: the series' entry in docs/series.js ({ series: '<slug in godsofpoker.com/series/<slug>>' })
  api.configure = (source) => {
    if (source && source.series) { SERIES = source.series; SERIES_URL = `${SITE}/series/${SERIES}`; }
    Object.assign(api, { SERIES, SERIES_URL });
    return api;
  };
  return api;
});
