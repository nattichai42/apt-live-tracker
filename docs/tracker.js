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
  const REG_GRACE = 300; // seconds after the published registration close that a re-entry is still accepted

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
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} for ${url}`);
      err.status = r.status;
      const ra = r.headers && r.headers.get && r.headers.get('retry-after');
      if (ra && !isNaN(Number(ra))) err.retryAfter = Number(ra);
      throw err;
    }
    const j = await r.json();
    const nodes = (j.nodes || []).map((n) => (n && n.type === 'data' ? unflatten(n.data) : null));
    return nodes[nodes.length - 1] || {};
  }

  function emptyState() {
    return { v: 1, series: SERIES, updatedAt: 0, listAt: 0, events: {}, results: {}, feed: [] };
  }

  // Name edits by the floor ("Kaigorodtsev Andrei" -> "Andrei Kaigorodtsev", "King-Chung Wang" -> "Wang Philip King Chung")
  const nameTokens = (n) => clean(n).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  function similarNames(a, b) {
    const A = nameTokens(a), B = nameTokens(b);
    if (!A.length || !B.length) return false;
    if (A.join('') === B.join('') || A.slice().sort().join(' ') === B.slice().sort().join(' ')) return true;
    const setB = new Set(B);
    const shared = new Set(A.filter((t) => setB.has(t))).size;
    return shared >= 2 && shared / Math.min(new Set(A).size, setB.size) >= 0.6;
  }
  // Follow renames to the current spelling
  function canon(state, n) {
    let k = 0; while (state.aliases && state.aliases[n] && k++ < 8) n = state.aliases[n];
    return n;
  }
  function renameInEvent(state, e, from, to) {
    const a = e.p[from], b = e.p[to];
    if (!a) return;
    if (b) {
      // Both exist (repair of saved history): the new name's first "entry" was not a new bullet
      b.f = Math.min(a.f, b.f); b.b = (a.b || 0) + Math.max(0, (b.b || 1) - 1);
      b.x = [...(a.x || []), ...(b.x || [])].sort((x, y) => x - y);
      if (a.r || b.r) b.r = [...new Set([...(a.r || []), ...(b.r || [])])].sort((x, y) => x - y);
      if (a.carry && !b.carry) b.carry = a.carry;
      b.cc = b.cc || a.cc;
    } else e.p[to] = a;
    delete e.p[from];
    for (const f of state.feed) if (f.kid === e.kid && f.n === from) f.n = to;
    (state.aliases || (state.aliases = {}))[from] = to;
  }

  // "[Event 1] National Cup Championship - Flight A - TWD 20,000,000 GTD" -> "[Event 1] National Cup Championship"
  const baseName = (name) => clean(name).split(/ - (?=(?:Turbo )?Flight\b|Day \d|Final Day|Final Table)/)[0];
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
    const prev = { ...(e.seats || {}) };
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
      const glitchWindow = 180; // back in the very same seat within 3 min = a data blip (a later same-seat return can be a rebuy)
      // Renames: a name that left and a similar name that sat down in the very same seat in this poll are one player
      for (const [y, s] of Object.entries(cur)) {
        if (prev[y] || e.p[y]) continue;
        const x = Object.keys(prev).find((n) => !cur[n] && prev[n][0] && prev[n][0] === s[0] && prev[n][1] === s[1] && e.p[n] && e.p[n].st === 's' && similarNames(n, y));
        if (!x) continue;
        renameInEvent(state, e, x, y);
        prev[y] = prev[x]; delete prev[x];
        res.renames = (res.renames || 0) + 1;
      }
      for (const n of Object.keys(prev)) {
        if (cur[n]) continue;
        const p = e.p[n];
        if (!p || p.st !== 's') continue;
        if (e.phase === 'Completed') continue; // handled below
        p.st = 'x'; p.x.push(now); p.xe = e.entries; res.busts++;
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
          // A return only counts as a re-entry while registration is open and the official entry count went up.
          const regOpen = !e.regClose || now <= e.regClose + REG_GRACE;
          const entriesGrew = p.xe == null || e.entries == null || e.entries > p.xe;
          if ((sameSeat && now - last <= glitchWindow) || !regOpen || !entriesGrew) {
            // Not a real bust: undo it
            p.x.pop(); res.busts--;
            for (let i = state.feed.length - 1; i >= 0; i--) {
              const f = state.feed[i];
              if (f.kid === kid && f.n === n && f.k === 'bust' && f.t === last) { state.feed.splice(i, 1); break; }
            }
          } else {
            p.b = (p.b || 0) + 1; res.reentries++; (p.r || (p.r = [])).push(now);
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

  const payoutsComplete = (rows) => {
    const pos = rows.map((r) => r[0]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return pos.length > 0 && pos[0] === 1 && pos.every((x, i) => x === i + 1 || x === pos[i - 1]);
  };
  const sameRows = (a, b) => (a || []).length === (b || []).length && (a || []).every((r, i) => r[0] === b[i][0] && r[1] === b[i][1] && r[3] === b[i][3]);

  async function fetchResults(fetchFn, state, num, now) {
    const kids = Object.values(state.events).filter((x) => x.num === num).sort((a, b) => (b.start || 0) - (a.start || 0));
    if (!kids.length) return false;
    const d = await getData(fetchFn, `${BASE}/${kids[0].kid}/results/__data.json`);
    const rows = (d.results || []).filter((r) => r && r.name).map((r) => [r.position, clean(r.name), r.countryCode || '', Math.round(r.amount || 0)]);
    // Final only once the payout list is complete (1st place listed, no gaps) and unchanged since the last fetch:
    // the site fills in the top places some time after the event is marked Completed.
    const done = kids.every((x) => x.phase === 'Completed');
    const prevR = state.results[num];
    const same = !!prevR && sameRows(prevR.rows, rows);
    const stable = same ? (prevR.stable || 0) + 1 : 0; // consecutive unchanged fetches (5 min apart)
    // Satellites list only some places (seats, cash spots), so they never look "complete": accept 30 min unchanged.
    const sat = kids.some((x) => x.sat);
    const final = done && same && (payoutsComplete(rows) || ((sat || !rows.length) && stable >= 6) || stable >= 72);
    // When each paid place first appeared. Rows already there on our first fetch get null (paid before we watched).
    const prev = state.results[num];
    const seen = (prev && prev.seen) || {};
    for (const [, n] of rows) if (!(n in seen)) seen[n] = prev && prev.seen ? now : null;
    state.results[num] = { at: now, final, rows, seen, stable };
    return true;
  }

  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String(err && err.message || err), status: err && err.status, retryAfter: err && err.retryAfter }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  // Undo re-entries recorded before the rules above existed: any "re-entry" after registration closed
  // was a player briefly missing from the seating list, so its bust and re-entry are removed. Idempotent.
  function repair(state) {
    let fixed = 0;
    // Payouts saved as final while the site was still filling them in
    for (const r of Object.values(state.results || {})) if (r.final && !payoutsComplete(r.rows)) { r.final = false; r.at = 0; fixed++; }
    // Completed events whose last players were left marked as seated
    for (const e of Object.values(state.events || {})) if (e.phase === 'Completed' && e.closed && e.p) {
      for (const p of Object.values(e.p)) if (p.st === 's') { p.st = 'end'; fixed++; }
    }
    // Renames saved as a bust of the old name plus a new entry of a similar name in the same poll
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const B = state.feed[i];
      if (!B || B.k !== 'bust') continue;
      const j = state.feed.findIndex((E) => E.k === 'entry' && E.kid === B.kid && E.t === B.t && E.n !== B.n && similarNames(E.n, B.n));
      if (j < 0) continue;
      const e = state.events[B.kid];
      const E = state.feed[j];
      if (!e || !e.p[B.n] || !e.p[E.n] || e.p[B.n].st === 's') continue;
      const a = e.p[B.n];
      a.x = (a.x || []).filter((t) => t !== B.t);
      state.feed.splice(Math.max(i, j), 1); state.feed.splice(Math.min(i, j), 1);
      renameInEvent(state, e, B.n, E.n);
      fixed++;
      i = Math.min(i, state.feed.length);
    }
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const f = state.feed[i];
      if (f.k !== 'reentry') continue;
      const e = state.events[f.kid];
      if (!e || !e.regClose || f.t <= e.regClose + REG_GRACE) continue;
      const p = e.p && e.p[f.n];
      state.feed.splice(i, 1); fixed++;
      if (!p) continue;
      p.b = Math.max(1, (p.b || 1) - 1);
      if (p.r) p.r = p.r.filter((t) => t !== f.t);
      const bt = (p.x || []).filter((t) => t < f.t).pop();
      if (bt != null) {
        p.x.splice(p.x.lastIndexOf(bt), 1);
        for (let j = state.feed.length - 1; j >= 0; j--) {
          const g = state.feed[j];
          if (g.kid === f.kid && g.n === f.n && g.k === 'bust' && g.t === bt) { state.feed.splice(j, 1); if (j < i) i--; break; }
        }
      }
      // Later feed items for this player in this event carry a bullet number that is now one too high
      for (const g of state.feed) if (g.kid === f.kid && g.n === f.n && g.t > f.t && g.b > 1) g.b--;
    }
    return fixed;
  }

  /**
   * One polling round. opts: {fetchFn, interval (s), listEvery (s), resultsEvery (s), concurrency}
   * Returns a summary.
   */
  const THROTTLE = new Set([403, 429, 503]);

  async function pollOnce(state, opts = {}) {
    const baseFetch = opts.fetchFn || ((u) => fetch(u, { cache: 'no-store' }));
    const interval = opts.interval || 60;
    const now = nowSec();
    const summary = { at: now, events: 0, busts: 0, reentries: 0, entries: 0, errors: [], requests: 0, throttled: 0, retryAfter: 0, repaired: repair(state) };
    const fetchFn = (u) => { summary.requests++; return baseFetch(u); };
    const note = (err) => {
      summary.errors.push(err.error || err.message || String(err));
      if (THROTTLE.has(err.status)) { summary.throttled++; summary.retryAfter = Math.max(summary.retryAfter, err.retryAfter || 0); }
    };
    if (!state.listAt || now - state.listAt >= (opts.listEvery || 300) || !Object.keys(state.events).length) {
      try { mergeList(state, await fetchEventList(fetchFn), now); } catch (err) { note({ error: 'list: ' + err.message, status: err.status, retryAfter: err.retryAfter }); }
    }
    const kids = activeKids(state, now);
    const got = await pool(kids, opts.concurrency || 4, async (kid) => {
      const e0 = state.events[kid];
      // Entry counts matter while registration is open (re-entry check); after that, status once a minute is enough
      const regOpen = !e0.regClose || now <= e0.regClose + REG_GRACE;
      const needEv = regOpen || !e0.evAt || now - e0.evAt >= (opts.evEvery || 60) || e0.phase === 'Completed';
      const [ev, ls] = await Promise.all([
        needEv ? getData(fetchFn, `${BASE}/${kid}/__data.json`) : Promise.resolve(null),
        getData(fetchFn, `${BASE}/${kid}/live-seating/__data.json`),
      ]);
      return { kid, ev: ev && ev.event, players: (ls && ls.players) || null };
    });
    for (const g of got) {
      if (!g || g.error) { note(g || { error: 'unknown' }); continue; }
      const e = state.events[g.kid];
      if (g.ev) { Object.assign(e, eventMeta({ ...g.ev, startTimeUTC: g.ev.startTimeUTC, regCloseUTC: g.ev.regCloseUTC || (e.regClose ? new Date(e.regClose * 1000).toISOString() : null) })); e.evAt = now; }
      if (g.ev && g.ev.startingStack) e.stack = g.ev.startingStack;
      if (!g.players || (e.phase === 'Completed' && !g.players.length)) {
        if (e.phase === 'Completed') {
          // Seating list is gone at the end: whoever was still seated at our last poll finished the event
          for (const p of Object.values(e.p || {})) if (p.st === 's') p.st = 'end';
          e.closed = 1;
        }
        continue;
      }
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
      if (allDone) return !r || (!r.final && now - r.at >= (opts.resultsEvery || 300));
      if (anyItm) return !r || now - r.at >= (opts.resultsEvery || 300);
      return false;
    });
    const rs = await pool(want, opts.concurrency || 4, (num) => fetchResults(fetchFn, state, num, now));
    for (const r of rs) if (r && r.error) note(r);
    state.updatedAt = now;
    return summary;
  }

  /* ---------- Derived views ---------- */

  function resultsByName(state) {
    const m = new Map();
    for (const [num, r] of Object.entries(state.results)) for (const [pos, n0, cc, prize] of r.rows) {
      const n = canon(state, n0);
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
      for (const [n0, p] of Object.entries(e.p || {})) {
        const r = get(canon(state, n0)); if (p.cc) r.cc = p.cc;
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

  // A player's record in one event, under whatever spelling that event used
  function pOf(state, e, name) {
    if (!e.p) return null;
    if (e.p[name]) return e.p[name];
    for (const k of Object.keys(e.p)) if (canon(state, k) === name) return e.p[k];
    return null;
  }

  // Best estimate of when a player's cash happened (their bust in that event, not when we fetched payouts)
  function cashTime(state, num, name, r, info) {
    const kids = Object.values(state.events).filter((x) => x.num === num);
    let bust = 0, end = 0;
    for (const e of kids) {
      const p = pOf(state, e, name); if (!p) continue;
      for (const t of p.x || []) if (t > bust) bust = t;
      if (p.st === 'end' && e.lastPoll > end) end = e.lastPoll;
    }
    if (end && end >= bust) return { t: end };
    if (bust) return { t: bust };
    const seenKey = r.seen && Object.keys(r.seen).find((k) => canon(state, k) === name);
    if (seenKey && r.seen[seenKey]) return { t: r.seen[seenKey] };
    const firsts = kids.filter((x) => x.firstPoll).map((x) => x.firstPoll);
    if (firsts.length) return { t: Math.min(...firsts) - 1, before: true }; // paid before we started watching
    return { t: (info.lastStart || r.at) + 1, approx: true };
  }

  // Timeline for one player, with money: every bullet costs the event's buy-in (amt < 0), every cash pays (amt > 0).
  // Running `bank` is the cumulative sum, for the bankroll graph.
  function playerTimeline(state, name) {
    const items = [];
    const nums = new Map(); // num -> {bullets seen, earliest start, name, buyin}
    const numInfo = (num) => {
      if (!nums.has(num)) {
        const kids = Object.values(state.events).filter((x) => x.num === num);
        const first = kids.slice().sort((a, b) => (a.start || 0) - (b.start || 0))[0] || {};
        nums.set(num, { bullets: 0, start: first.start || null, lastStart: Math.max(0, ...kids.map((x) => x.start || 0)) || null,
          lastPoll: Math.max(0, ...kids.map((x) => x.lastPoll || 0)) || null, tracked: kids.some((x) => x.polls > 0),
          name: first.name || '#' + num, buyin: first.buyin || 0 });
      }
      return nums.get(num);
    };
    for (const e of Object.values(state.events)) {
      const p = pOf(state, e, name); if (!p) continue;
      const info = numInfo(e.num);
      const base = { num: e.num, kid: e.kid, ev: e.name };
      const bullets = p.b || 0;
      info.bullets += bullets;
      if (p.carry) items.push({ ...base, t: p.f, k: 'carry' });
      else items.push({ ...base, t: p.f, k: 'seen', first: e.firstPoll === p.f, b: 1, amt: bullets ? -e.buyin : 0 });
      // Re-entry times: stored on the record, plus any older ones still in the feed
      const times = new Set(p.r || []);
      for (const f of state.feed) if (f.k === 'reentry' && f.kid === e.kid && canon(state, f.n) === name) times.add(f.t);
      const rt = [...times].sort((a, b) => a - b);
      const extra = Math.max(0, bullets - 1);
      for (let i = 0; i < extra; i++) items.push({ ...base, t: rt[i] != null ? rt[i] : p.f, k: 'reentry', b: i + 2, amt: -e.buyin, approxTime: rt[i] == null });
      (p.x || []).forEach((t) => items.push({ ...base, t, k: 'bust' }));
      if (p.st === 'end') items.push({ ...base, t: e.lastPoll, k: 'end' });
    }
    for (const [numS, r] of Object.entries(state.results)) for (const [pos, n, , prize] of r.rows) if (canon(state, n) === name) {
      const num = Number(numS);
      const info = numInfo(num);
      const cashEv = baseName(info.name);
      if (info.bullets === 0) {
        // Not watched from the start: assume one bullet on the event's first day
        info.bullets = 1; items.push({ t: info.start || r.at, approx: true, k: 'buyin', num, ev: cashEv, amt: -info.buyin });
      }
      items.push({ ...cashTime(state, num, name, r, info), k: 'cash', num, ev: cashEv, pos, prize, amt: prize });
    }
    // Seen only as a carry-over into a later day: count the one bullet from the flight we did not watch
    for (const [num, info] of nums) if (info.bullets === 0) {
      info.bullets = 1;
      items.push({ t: info.start || 0, approx: true, k: 'buyin', num, ev: info.name, amt: -info.buyin });
    }
    const order = { buyin: 0, seen: 1, carry: 1, reentry: 2, bust: 3, end: 4, cash: 5 };
    items.sort((a, b) => (a.t || 0) - (b.t || 0) || order[a.k] - order[b.k]);
    let bank = 0;
    for (const it of items) { if (it.amt) bank += it.amt; it.bank = bank; }
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
          reentriesSeen: re,
          // A flight's entry count covers that flight only; a later day's (Day 2, Final Day) covers every flight.
          // Missed = entries - every bullet we saw = players seen + re-entries seen, subtracted from the official count.
          untracked: e.entries == null ? null : isLaterDay(e.name) ? (fullyTracked ? Math.max(0, e.entries - seenAll) : null) : Math.max(0, e.entries - seen),
          laterDay: isLaterDay(e.name),
          // Bullets we counted beyond the official number (the site lowers it when a registration is cancelled)
          over: e.entries == null || isLaterDay(e.name) ? 0 : Math.max(0, seen - e.entries),
          trackedFromStart: !!(e.firstPoll && e.start && e.firstPoll - e.start < 900),
          bustsLast15: recent, busts: ps.reduce((a, p) => a + (p.x || []).length, 0), firstPoll: e.firstPoll, lastPoll: e.lastPoll, sat: e.sat };
      })
      .sort((a, b) => (a.phase === 'Completed') - (b.phase === 'Completed') || (b.entries || 0) - (a.entries || 0));
  }

  // Everyone tracked in one event (flight/day), joined with that event's results
  function eventPlayers(state, kid) {
    const e = state.events[kid]; if (!e) return [];
    const res = new Map(((state.results[e.num] || {}).rows || []).map(([pos, n, cc, prize]) => [canon(state, n), { pos, prize, cc, raw: n }]));
    const out = Object.entries(e.p || {}).map(([n, p]) => {
      const seat = e.seats && e.seats[n];
      const r = res.get(canon(state, n));
      return { name: n, cc: p.cc || (r && r.cc) || '', status: p.st === 's' ? 'seated' : p.st === 'end' ? 'end' : 'busted',
        table: seat ? seat[0] : null, seat: seat ? seat[1] : null, bullets: p.b || 0, carry: !!p.carry,
        firstSeen: p.f, busts: p.x || [], lastBust: (p.x || [])[(p.x || []).length - 1] || null,
        atStart: p.f === e.firstPoll, pos: r ? r.pos : null, prize: r ? r.prize : null };
    });
    // Cashers we never saw seated (e.g. results from before tracking)
    for (const [n, r] of res) if (!pOf(state, e, n) && Object.values(state.events).filter((x) => x.num === e.num).every((x) => !pOf(state, x, n)))
      out.push({ name: n, cc: r.cc, status: 'cashed', table: null, seat: null, bullets: 0, busts: [], lastBust: null, pos: r.pos, prize: r.prize });
    return out;
  }

  // One row per finished event (flights and days combined), newest first
  function completedEvents(state) {
    const byNum = new Map();
    for (const e of Object.values(state.events)) { if (!byNum.has(e.num)) byNum.set(e.num, []); byNum.get(e.num).push(e); }
    const out = [];
    for (const [num, kids] of byNum) {
      if (!kids.length || !kids.every((e) => e.phase === 'Completed')) continue;
      const r = state.results[num];
      if (!r || !r.rows.length) continue; // nothing paid out (e.g. events not played)
      const last = kids.slice().sort((a, b) => (b.start || 0) - (a.start || 0))[0];
      const later = kids.filter((e) => isLaterDay(e.name));
      // A later day's entry count already covers every flight; otherwise flights add up
      const entries = later.length ? Math.max(...later.map((e) => e.entries || 0)) : kids.reduce((a, e) => a + (e.entries || 0), 0);
      const win = r.rows.find((x) => x[0] === 1);
      out.push({ kid: last.kid, num, name: baseName(last.name), buyin: last.buyin, sat: kids.some((e) => e.sat), entries,
        prizePool: Math.max(...kids.map((e) => e.prizePool || 0)), paid: r.rows.length, final: !!r.final,
        finished: Math.max(...kids.map((e) => e.lastPoll || 0)) || Math.max(...kids.map((e) => e.start || 0)),
        tracked: kids.some((e) => e.polls > 0),
        winner: win ? { name: canon(state, win[1]), cc: win[2], prize: win[3] } : null });
    }
    return out.sort((a, b) => b.finished - a.finished || b.num - a.num);
  }

  function upcoming(state, now, hours) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.phase !== 'Completed' && !e.polls && e.start && e.start > now - 300 && e.start <= now + (hours || 12) * 3600)
      .sort((a, b) => a.start - b.start || a.num - b.num)
      .map((e) => ({ kid: e.kid, num: e.num, name: e.name, start: e.start, buyin: e.buyin, phase: e.phase, sat: e.sat }));
  }

  return { SITE, SERIES, BASE, ACTIVE, activeKids, eventPlayers, upcoming, completedEvents, repair, baseName, similarNames, canon, emptyState, pollOnce, applySnapshot, fetchEventList, mergeList, players, playerTimeline, liveEvents, unflatten, isLaterDay };
});
