/*
 * Triton live tracker engine. Shared by the GitHub Actions poller (Node) and the page (browser, read-only:
 * Triton's API only answers pages on tritonpoker.plus, so the browser shows what the poller saved).
 *
 * Triton Poker+ (tritonpoker.plus) loads its tournament data from a public GraphQL API. For every event it
 * lists each participant with their buy-in transactions (= bullets), whether they are alive, the time of their
 * latest bust, and live chip counts; payouts name the player in each paid place. So bullets, buy-ins and prizes
 * are exact. What the poller adds is timing: the time of each re-entry and of busts before the latest one,
 * seen as changes between snapshots.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TritonTracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SITE = 'https://tritonpoker.plus';
  const API = 'https://prod-public-serverless.triton-poker.com/graphql';
  const FESTIVAL = 'daca20f2-506a-4377-9c73-2651390b6782';
  const SERIES = 'triton-n-cyprus-2026';
  const SERIES_URL = `${SITE}/festival/${FESTIVAL}`;
  const BROWSER_POLL = false; // the API refuses other sites' pages (CORS)
  const FEED_CAP = 6000;

  const nowSec = () => Math.floor(Date.now() / 1000);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /* ---------- GraphQL (the queries the Triton Poker+ app itself sends) ---------- */
  const PARTICIPANT = `uuid currentChips alive isHidden noOfBounties noOfUnusedBullets
        user { uuid nickname countryCode } transactions { amount }`;
  const Q = {
    festival: `query GetFestival($festivalId: String!) { festival(festivalId: $festivalId) {
      uuid name shortName startDate endDate timeZone currency
      tournaments { uuid eventNo flight name buyIn startDate registrationFee registrationStatus noOfPlayersRemaining
        noOfEntries startingChips clockStatus statusNote isOngoing tournamentStatus live isSatellite
        days { uuid date name startTime endTime }
        currentBlindLevel { ... on SmallAndBigBlindLevel { bigBlind smallBlind ante } ... on AnteOnlyLevel { bigAnte smallAnte } }
        payouts { uuid winAmount } } } }`,
    participants: `query GetChipLeaders($tournamentId: String!, $participantsSize: Int!) { tournament(tournamentId: $tournamentId) {
      uuid name eventNo noOfPlayersRemaining noOfEntries noOfBullets startingChips tournamentStatus
      currentBlindLevel { ... on SmallAndBigBlindLevel { bigBlind smallBlind ante levelNo } ... on AnteOnlyLevel { bigAnte smallAnte levelNo } }
      participants(size: $participantsSize) {
        ... on SeatedParticipant { ${PARTICIPANT} }
        ... on StandingParticipant { ${PARTICIPANT} }
        ... on BustedParticipant { ${PARTICIPANT} bustedAt } } } }`,
    payouts: `query GetPayouts($tournamentId: String!) { tournament(tournamentId: $tournamentId) {
      uuid isSatellite noOfEntries
      payouts { uuid position winAmount bountyAmount currency participant { uuid noOfBounties user { uuid nickname countryCode } } } } }`,
  };

  async function gql(fetchFn, op, variables) {
    const r = await fetchFn(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: Q[op], variables }) });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} for ${op}`); err.status = r.status;
      const ra = r.headers && r.headers.get && r.headers.get('retry-after');
      if (ra && !isNaN(Number(ra))) err.retryAfter = Number(ra);
      throw err;
    }
    const j = await r.json();
    if (j.errors && j.errors.length && !j.data) throw new Error(`${op}: ${j.errors[0].message}`);
    return j.data;
  }

  /* ---------- time ---------- */
  // Wall-clock time in an IANA zone -> UTC seconds
  function zoned(date, time, tz) {
    const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return null;
    const t = String(time || '00:00').match(/^(\d{1,2}):(\d{2})/) || [0, '0', '0'];
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    const offsetAt = (ms) => {
      try {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
          .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
      } catch { return 0; }
    };
    let utc = guess - offsetAt(guess);
    utc = guess - offsetAt(utc); // settle across a DST change
    return Math.floor(utc / 1000);
  }
  const ymdIn = (sec, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000)); } catch { return ''; } };

  function emptyState() {
    return { v: 1, series: SERIES, updatedAt: 0, listAt: 0, festival: null, events: {}, res: {}, results: {}, feed: [], aliases: {} };
  }
  const canon = (state, n) => { let k = 0; while (state.aliases && state.aliases[n] && k++ < 8) n = state.aliases[n]; return n; };
  const personOf = (state, k) => canon(state, String(k).replace(/ \(\d+\)$/, ''));
  // "3" -> "#3"; in the all-time view events carry their festival: "3@Jeju II '26" -> "#3 · Jeju II '26"
  const label = (num) => { if (num == null) return ''; const [n, f] = String(num).split('@'); return '#' + n + (f ? ' · ' + f : ''); };
  // "2026 Triton Jeju II" -> "Jeju II '26", "2019 Triton SHR Series London" -> "London '19", "2026 Triton One Jeju" -> "One Jeju '26"
  function festTag(name, startDate) {
    const yr = String(startDate || '').slice(2, 4) || (String(name).match(/\b20(\d\d)\b/) || [])[1] || '';
    const place = clean(String(name || '').replace(/\b(19|20)\d\d\b/g, '').replace(/\bTriton\b/gi, '').replace(/\bSHR Series\b/gi, '').replace(/\bSuper High Roller Series\b/gi, ''));
    return (place || 'Triton') + (yr ? " '" + yr : '');
  }

  /* ---------- event metadata ---------- */
  // "$40K NLH Mystery Bounty", "£1.05M ...", "€20k ...", "500K HKD ...", "50K USD ..." -> the amount in the name
  const nameBuyin = (name) => {
    const m = String(name || '').match(/^\s*(?:HK\$|[$£€])?\s?([\d.,]+)\s?([KkMm])?\b/); if (!m) return null;
    const v = Number(m[1].replace(/,/g, '')) * (/[Mm]/.test(m[2] || '') ? 1e6 : /[Kk]/.test(m[2] || '') ? 1e3 : 1);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  };
  // The name is what players see; the schedule's buyIn field is sometimes wrong (HK$318M for a 2M HKD event).
  // Keep the listed amount only when it is the name's amount plus a fee of up to 10% (€20k listed as €21,200).
  const pickBuyin = (name, listed) => { const n = nameBuyin(name); if (!n) return listed || 0; return listed >= n && listed <= n * 1.1 ? listed : n; };
  // Rough USD value of one unit, for the all-time view (HKD is pegged; others at the festival's time)
  function usdRate(currency, startDate) {
    const y = Number(String(startDate || '').slice(0, 4));
    switch (currency) {
      case 'HKD': return 1 / 7.8;
      case 'GBP': return y <= 2019 ? 1.22 : 1.27;
      case 'EUR': return y <= 2022 ? 1.06 : 1.08;
      default: return 1;
    }
  }

  function mergeFestival(state, f, now) {
    if (!f) return;
    state.festival = { name: f.name, shortName: f.shortName, startDate: f.startDate, endDate: f.endDate, timeZone: f.timeZone || 'UTC', currency: f.currency || 'USD' };
    const tz = state.festival.timeZone;
    for (const t of f.tournaments || []) {
      const e = state.events[t.uuid] || (state.events[t.uuid] = { kid: t.uuid, p: {}, ids: {}, polls: 0 });
      e.num = String(t.eventNo); e.ord = Number(t.eventNo) || 999;
      e.base = clean(t.name) + (t.flight ? ' ' + clean(t.flight) : '');
      e.buyinListed = Math.round((Number(t.buyIn) || 0) + (Number(t.registrationFee) || 0));
      e.buyin = pickBuyin(t.name, e.buyinListed);
      e.days = (t.days || []).map((d) => ({ name: clean(d.name), date: d.date, t: zoned(d.date, d.startTime || '12:00', tz) }));
      e.start = (e.days[0] && e.days[0].t) || zoned(t.startDate, '12:00', tz);
      e.status = t.tournamentStatus; e.reg = t.registrationStatus; e.clock = t.clockStatus; e.note = clean(t.statusNote);
      e.ongoing = !!t.isOngoing; e.sat = !!t.isSatellite; e.stack = t.startingChips;
      if (t.noOfEntries != null) e.entries = t.noOfEntries;
      if (t.noOfPlayersRemaining != null) e.remaining = t.noOfPlayersRemaining;
      e.paid = (t.payouts || []).length;
      e.prizePool = (t.payouts || []).reduce((a, p) => a + (Number(p.winAmount) || 0), 0);
      const b = t.currentBlindLevel; e.blinds = b ? (b.bigBlind ? [b.smallBlind, b.bigBlind, b.ante] : [b.smallAnte, b.bigAnte, null]) : null;
      if (e.status === 'COMPLETED' && !e.doneAt && e.polls) e.doneAt = now;
    }
    state.listAt = now;
  }

  function dayPart(e, now, tz) {
    if (!e.days || e.days.length < 2) return '';
    const today = ymdIn(now, tz);
    const cur = e.days.filter((d) => d.date <= today).pop() || e.days[0];
    return cur.name ? (/^\d+$/.test(cur.name) ? 'Day ' + cur.name : cur.name) : '';
  }

  function computePhase(e) {
    if (e.status === 'COMPLETED') return 'Completed';
    if (e.status !== 'IN_PROGRESS') return e.reg === 'OPEN' ? 'Reg Open' : 'Upcoming';
    if (e.reg === 'OPEN') return 'Late Reg';
    if (e.paid && e.remaining != null && e.remaining <= e.paid) return e.remaining <= 8 ? 'Final Table' : 'In The Money';
    if (e.clock === 'PAUSED') return 'Paused';
    return 'Running';
  }

  function pushFeed(state, item) {
    state.feed.push(item);
    if (state.feed.length > FEED_CAP) state.feed.splice(0, state.feed.length - FEED_CAP);
  }
  const sortFeed = (state) => state.feed.sort((a, b) => a.t - b.t);

  /* ---------- core diff ---------- */
  function applySnapshot(state, kid, t, now) {
    const e = state.events[kid];
    const res = { busts: 0, reentries: 0, entries: 0 };
    const rows = (t.participants || []).filter((p) => p && p.user && clean(p.user.nickname) && !p.isHidden);
    if (!rows.length && Object.keys(e.p).length > 3) return res;
    const first = !e.firstPoll;
    if (first) { e.firstPoll = now; if ((t.tournamentStatus || e.status) === 'COMPLETED') e.backfilled = 1; }
    e.ids = e.ids || {};
    let late = false, txAll = 0;
    for (const r of rows) {
      const uid = r.user.uuid || r.uuid, name = clean(r.user.nickname), cc = (r.user.countryCode || '').toUpperCase();
      let k = e.ids[uid];
      if (!k) { k = name; let i = 2; while (e.p[k] && e.p[k].uid !== uid) k = `${name} (${i++})`; e.ids[uid] = k; }
      else if (personOf(state, k) !== name && !e.p[name]) {
        // Nickname edited: follow the new spelling
        const old = personOf(state, k);
        e.p[name] = e.p[k]; delete e.p[k]; e.ids[uid] = name;
        for (const f of state.feed) if (f.kid === kid && f.n === old) f.n = name;
        state.aliases[old] = name; k = name;
      }
      const n = personOf(state, k);
      const tx = (r.transactions || []).map((x) => Number(x.amount) || 0);
      txAll += tx.length;
      const bullets = Math.max(1, tx.length);
      const bust = r.bustedAt ? Math.floor(Number(r.bustedAt) / 1000) : null;
      let p = e.p[k];
      if (!p) {
        p = e.p[k] = { uid, b: bullets, st: r.alive ? 's' : 'x', f: now, x: [], cc, paid: tx.reduce((a, v) => a + v, 0) };
        if (!first) { res.entries++; pushFeed(state, { t: now, kid, num: e.num, n, k: 'entry', b: 1, cc }); }
        if (bullets > 1) p.early = bullets - 1; // bought before we saw them: re-entry times unknown
        if (!r.alive && bust) { p.x.push(bust); if (!first) res.busts++; pushFeed(state, { t: bust, kid, num: e.num, n, k: 'bust', b: bullets, cc }); late = true; }
      } else {
        // New bullets since the last poll: re-entries (time = this poll)
        for (let i = p.b; i < bullets; i++) {
          (p.r || (p.r = [])).push(now); res.reentries++;
          pushFeed(state, { t: now, kid, num: e.num, n, k: 'reentry', b: i + 1, cc });
        }
        p.b = Math.max(p.b, bullets);
        p.paid = Math.max(p.paid || 0, tx.reduce((a, v) => a + v, 0));
        if (!r.alive && bust && !p.x.includes(bust)) {
          // A bust we hadn't recorded (its exact time comes from the site)
          p.x.push(bust); p.x.sort((a, b2) => a - b2); res.busts++;
          pushFeed(state, { t: bust, kid, num: e.num, n, k: 'bust', b: p.b, cc }); late = true;
        }
        if (p.st !== 'end') p.st = r.alive ? 's' : 'x';
      }
      if (cc) p.cc = cc;
      p.chips = r.alive ? Number(r.currentChips) || 0 : 0;
      p.bounties = r.noOfBounties || 0;
      p.l = now;
    }
    if (late) sortFeed(state);
    if (t.noOfEntries != null) e.entries = t.noOfEntries;
    if (t.noOfPlayersRemaining != null) e.remaining = t.noOfPlayersRemaining;
    // Before Sep 2026 Triton kept no per-player buy-ins: bullets there are 1 per player, re-entries unattributed
    e.txMissing = e.entries != null && txAll < e.entries ? e.entries - txAll : 0;
    const lv = t.currentBlindLevel; if (lv) { e.level = lv.levelNo; e.blinds = lv.bigBlind ? [lv.smallBlind, lv.bigBlind, lv.ante] : [lv.smallAnte, lv.bigAnte, null]; }
    if (t.tournamentStatus) e.status = t.tournamentStatus;
    e.alive = Object.values(e.p).filter((p) => p.st === 's').length;
    e.lastPoll = now; e.polls = (e.polls || 0) + 1;
    return res;
  }

  function applyPayouts(state, e, t, now) {
    const rows = (t.payouts || []).filter((p) => p && p.position != null).map((p) => {
      const u = p.participant && p.participant.user;
      return [Number(p.position), u ? clean(u.nickname) : null, u ? (u.countryCode || '').toUpperCase() : '', Math.round((Number(p.winAmount) || 0) + (Number(p.bountyAmount) || 0)), u ? u.uuid : null];
    }).sort((a, b) => a[0] - b[0]);
    const prev = state.res[e.kid];
    const sig = JSON.stringify(rows);
    const same = !!prev && prev.sig === sig;
    const since = same ? prev.since : now;
    state.res[e.kid] = { at: now, rows, sig, since, final: e.status === 'COMPLETED' && same && now - since >= 1800 };
    e.paid = rows.length;
    e.prizePool = rows.reduce((a, r) => a + r[3], 0) || e.prizePool;
  }

  function settle(state, e, now) {
    if (e.status !== 'COMPLETED') { if (e.doneAt && e.status === 'IN_PROGRESS') delete e.doneAt; return; }
    // Finished before we first looked: it ended around its last bust
    if (!e.doneAt) e.doneAt = e.backfilled ? (Math.max(0, ...Object.values(e.p).flatMap((p) => p.x || [])) + 60 || now) : now;
    const win = ((state.res[e.kid] || {}).rows || []).find((r) => r[0] === 1);
    for (const [k, p] of Object.entries(e.p)) {
      if (p.st === 's') { p.st = 'end'; if (win && (win[4] === p.uid || win[1] === personOf(state, k))) p.won = 1; }
    }
  }

  function buildResults(state) {
    const out = {};
    for (const e of Object.values(state.events)) {
      const r = state.res[e.kid];
      if (!r) continue;
      const rows = []; const seen = {};
      for (const [pos, n0, cc, prize, uid] of r.rows) {
        if (!n0) continue;
        const k = uid && e.ids && e.ids[uid];
        const n = k ? personOf(state, k) : canon(state, n0);
        rows.push([pos, n, cc, prize]);
        const p = k && e.p[k];
        seen[n] = p ? (p.x.length ? p.x[p.x.length - 1] : (e.doneAt || r.at)) : r.at;
      }
      if (rows.length) out[e.num] = { at: r.at, final: r.final, rows, seen, open: r.rows.filter((x) => !x[1]).length };
    }
    state.results = out;
  }

  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String(err && err.message || err), status: err && err.status, retryAfter: err && err.retryAfter }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  // Running, about to start, or finished within the last 2 hours (payouts still settling)
  function activeKids(state, now) {
    return Object.values(state.events).filter((e) => {
      if (e.closed) return false;
      if (e.status === 'IN_PROGRESS' || e.reg === 'OPEN') return true;
      if (e.status === 'COMPLETED') return !!e.polls && now - (e.doneAt || now) < 7200;
      return e.start && e.start <= now + 600 && e.start > now - 86400;
    }).map((e) => e.kid);
  }

  const THROTTLE = new Set([403, 429, 503]);

  /** One polling round. opts: {fetchFn, listEvery, resultsEvery, concurrency, backfill} */
  async function pollOnce(state, opts = {}) {
    const baseFetch = opts.fetchFn || ((u, o) => fetch(u, { ...o, cache: 'no-store' }));
    const now = nowSec();
    const summary = { at: now, events: 0, busts: 0, reentries: 0, entries: 0, errors: [], requests: 0, throttled: 0, retryAfter: 0, repaired: 0 };
    const fetchFn = (u, o) => { summary.requests++; return baseFetch(u, o); };
    const note = (err) => {
      summary.errors.push(err.error || err.message || String(err));
      if (THROTTLE.has(err.status)) { summary.throttled++; summary.retryAfter = Math.max(summary.retryAfter, err.retryAfter || 0); }
    };
    state.res = state.res || {}; state.aliases = state.aliases || {};
    if (!state.listAt || now - state.listAt >= (opts.listEvery || 60) || !Object.keys(state.events).length) {
      const fid = opts.festival || state.festivalId || FESTIVAL; state.festivalId = fid;
      try { mergeFestival(state, (await gql(fetchFn, 'festival', { festivalId: fid })).festival, now); }
      catch (err) { note({ error: 'festival: ' + err.message, status: err.status, retryAfter: err.retryAfter }); }
    }
    // Finished events never watched: load them once (bullets, last busts and payouts are all on record)
    const back = (opts.backfill === false ? [] : Object.values(state.events).filter((e) => e.status === 'COMPLETED' && !e.polls)).map((e) => e.kid);
    const kids = [...new Set([...activeKids(state, now), ...back])];
    const got = await pool(kids, opts.concurrency || 3, async (kid) => ({ kid, t: (await gql(fetchFn, 'participants', { tournamentId: kid, participantsSize: 2000 })).tournament }));
    for (const g of got) {
      if (!g || g.error) { note(g || { error: 'unknown' }); continue; }
      if (!g.t) continue;
      const r = applySnapshot(state, g.kid, g.t, now);
      summary.events++; summary.busts += r.busts; summary.reentries += r.reentries; summary.entries += r.entries;
    }
    const want = Object.values(state.events).filter((e) => {
      if (!e.polls) return false;
      const r = state.res[e.kid];
      if (r && r.final) return false;
      if (!kids.includes(e.kid) && r) return false;
      return !r || now - r.at >= (opts.resultsEvery || 60);
    });
    const rs = await pool(want, opts.concurrency || 3, async (e) => { const d = await gql(fetchFn, 'payouts', { tournamentId: e.kid }); if (d.tournament) applyPayouts(state, e, d.tournament, now); });
    for (const r of rs) if (r && r.error) note(r);
    const tz = (state.festival && state.festival.timeZone) || 'UTC';
    for (const e of Object.values(state.events)) {
      settle(state, e, now);
      e.phase = computePhase(e);
      e.partShown = e.phase === 'Completed' ? '' : dayPart(e, now, tz);
      e.name = e.base + (e.partShown ? ' - ' + e.partShown : '');
      const r = state.res[e.kid];
      if (e.doneAt && ((r && r.final) || now - e.doneAt >= 6 * 3600)) e.closed = 1;
    }
    buildResults(state);
    state.updatedAt = now;
    return summary;
  }

  function repair() { return 0; }

  /* ---------- archive ---------- */
  // A finished festival as a small static file: drop what only live polling needs
  function slim(state) {
    // Results of a finished festival are final; the bust feed is rebuilt from bust times on load (feedFromBusts)
    const results = {}; for (const [k, r] of Object.entries(state.results || {})) results[k] = { ...r, final: true };
    const out = { v: 1, series: SERIES, archive: true, festivalId: state.festivalId, festival: state.festival, updatedAt: state.updatedAt,
      events: {}, results, feed: [], aliases: state.aliases || {} };
    for (const e of Object.values(state.events)) {
      if (!e.polls) continue;
      const { ids, days, blinds, level, note, clock, reg, ongoing, lastPoll, listed, ...keep } = e;
      keep.p = {};
      for (const [k, p] of Object.entries(e.p)) {
        const q = { uid: p.uid, b: p.b, st: p.st, f: p.f, x: p.x, cc: p.cc };
        if (p.paid) q.paid = p.paid; if (p.won) q.won = 1; if (p.early) q.early = p.early; if (p.r && p.r.length) q.r = p.r; if (p.bounties) q.bounties = p.bounties;
        keep.p[k] = q;
      }
      out.events[e.kid] = keep;
    }
    return out;
  }

  // Bust and re-entry feed from the players' recorded times (archived festivals don't store the feed)
  function feedFromBusts(state) {
    const feed = [];
    for (const e of Object.values(state.events || {})) for (const [k, p] of Object.entries(e.p || {})) {
      const n = personOf(state, k);
      const xs = (p.x || []).slice().sort((a, b) => a - b), rs = (p.r || []).slice().sort((a, b) => a - b);
      const known = (p.b || 1) - rs.length; // bullets whose start time we don't know
      xs.forEach((t, i) => feed.push({ t, kid: e.kid, num: e.num, n, k: 'bust', b: i === xs.length - 1 ? (p.b || 1) : Math.min(p.b || 1, known + i), cc: p.cc }));
      rs.forEach((t, i) => feed.push({ t, kid: e.kid, num: e.num, n, k: 'reentry', b: known + i + 1, cc: p.cc }));
    }
    state.feed = feed.sort((a, b) => a.t - b.t);
    return state;
  }

  // Several festivals as one state (all-time view). parts: [{state, tag, start}]. Event numbers become "3@Jeju II '26";
  // a player is one person across festivals by their Triton profile, under their latest nickname.
  function mergeStates(parts, opts = {}) {
    const out = emptyState(); out.merged = true; out.festivals = [];
    const latest = new Map(); // uid -> [start, name]
    for (const { state, tag, start } of parts) {
      out.festivals.push({ tag, start, name: state.festival && state.festival.name, id: state.festivalId });
      for (const e of Object.values(state.events || {})) for (const [k, p] of Object.entries(e.p || {})) {
        if (!p.uid) continue; const n = personOf(state, k); const cur = latest.get(p.uid);
        if (!cur || (start || '') >= cur[0]) latest.set(p.uid, [start || '', n]);
      }
    }
    for (const { state, tag, rate = 1 } of parts) {
      for (const [a, b] of Object.entries(state.aliases || {})) out.aliases[a] = b;
      for (const e0 of Object.values(state.events || {})) {
        // Amounts stay in the festival's currency (e.cur); the page converts them at each date's rate
        const e = { ...e0, num: `${e0.num}@${tag}`, fest: tag, cur: (state.festival && state.festival.currency) || 'USD',
          buyin: Math.round((e0.buyin || 0) * rate), prizePool: Math.round((e0.prizePool || 0) * rate) };
        e.p = {};
        for (const [k, p] of Object.entries(e0.p || {})) {
          const n = personOf(state, k); const want = p.uid && latest.get(p.uid) ? latest.get(p.uid)[1] : n;
          if (want !== n && !out.aliases[n]) out.aliases[n] = want; // older nickname -> latest
          e.p[k] = p;
        }
        out.events[e.kid] = e;
      }
      for (const [num, r] of Object.entries(state.results || {})) out.results[`${num}@${tag}`] = rate === 1 ? r : { ...r, rows: r.rows.map(([pos, n, cc, prize]) => [pos, n, cc, Math.round(prize * rate)]) };
      if (opts.feed) for (const f of state.feed || []) out.feed.push({ ...f, num: `${f.num}@${tag}` });
      out.updatedAt = Math.max(out.updatedAt, state.updatedAt || 0);
    }
    // No alias may point at itself through a chain
    for (const a of Object.keys(out.aliases)) { let n = out.aliases[a], k = 0; while (out.aliases[n] && k++ < 8) n = out.aliases[n]; if (n === a) delete out.aliases[a]; }
    if (opts.feed) out.feed.sort((a, b) => a.t - b.t);
    return out;
  }

  /* ---------- derived views ---------- */
  const kidsOf = (state, num) => Object.values(state.events).filter((e) => e.num === String(num));
  const fromStart = (e) => !!(e.firstPoll && e.start && e.firstPoll - e.start < 900);
  function watchedFromStart(state, num) { const k = kidsOf(state, num); return k.length > 0 && k.every((e) => fromStart(e)); }
  function eventFinished(state, num) { const k = kidsOf(state, num); return k.length > 0 && k.every((e) => e.phase === 'Completed'); }
  const buyinOf = (state, num) => Math.max(0, ...kidsOf(state, num).map((e) => e.buyin || 0));

  function players(state, opts = {}) {
    const cache = new Map();
    const keep = (num) => {
      if (opts.only && !opts.only(num)) return false;
      if (!opts.fromStart && !opts.finished) return true;
      if (!cache.has(num)) cache.set(num, (!opts.fromStart || watchedFromStart(state, num)) && (!opts.finished || eventFinished(state, num)));
      return cache.get(num);
    };
    const map = new Map();
    const get = (n) => map.get(n) || (map.set(n, { name: n, cc: '', nums: new Set(), bullets: 0, buyins: 0, busts: 0, seatedIn: [], lastBust: 0, cashes: [], partial: false }), map.get(n));
    for (const e of Object.values(state.events)) {
      if (!e.polls || !keep(e.num)) continue;
      for (const [k, p] of Object.entries(e.p)) {
        const r = get(personOf(state, k)); if (p.cc) r.cc = p.cc;
        r.nums.add(e.num); r.bullets += p.b || 1;
        if (e.txMissing && !(p.paid > 0)) r.partial = true; // re-entries here are not on record: at least this many
        // Bullets x buy-in from the name (the site's transaction amounts leave out the fee)
        r.buyins += (p.b || 1) * (e.buyin || 0);
        r.busts += Math.max((p.x || []).length, p.st === 'x' ? (p.b || 1) : Math.max(0, (p.b || 1) - 1));
        if (p.st === 's' && e.phase !== 'Completed') r.seatedIn.push(label(e.num));
        const lb = (p.x || [])[(p.x || []).length - 1]; if (lb && lb > r.lastBust) r.lastBust = lb;
      }
    }
    for (const [num, res] of Object.entries(state.results)) {
      if (!keep(num)) continue;
      for (const [pos, n, cc, prize] of res.rows) {
        const r = get(canon(state, n)); if (!r.cc && cc) r.cc = cc;
        r.cashes.push({ num, pos, prize, cc, final: res.final });
        if (!r.nums.has(num)) { r.nums.add(num); r.bullets += 1; r.buyins += buyinOf(state, num); }
      }
    }
    const out = [];
    for (const r of map.values()) {
      const prizes = r.cashes.reduce((a, c) => a + c.prize, 0);
      const cashedNums = new Set(r.cashes.map((c) => c.num));
      const entered = r.nums.size;
      out.push({ name: r.name, cc: r.cc, events: entered, bullets: r.bullets, reentries: Math.max(0, r.bullets - entered), busts: r.busts,
        buyins: r.buyins, prizes, net: prizes - r.buyins, cashes: r.cashes.length, itm: entered ? cashedNums.size / entered : 0,
        seatedIn: r.seatedIn, lastBust: r.lastBust || null, partial: !!r.partial, cashedEvents: cashedNums.size, wins: r.cashes.filter((c) => c.pos === 1).length });
    }
    out.sort((a, b) => b.prizes - a.prizes || b.bullets - a.bullets || a.name.localeCompare(b.name));
    return out;
  }

  function pOf(state, e, name) {
    if (e.p[name]) return e.p[name];
    for (const k of Object.keys(e.p)) if (personOf(state, k) === name) return e.p[k];
    return null;
  }

  function playerTimeline(state, name) {
    const items = [];
    const seenNums = new Set();
    for (const e of Object.values(state.events)) {
      const p = e.polls && pOf(state, e, name); if (!p) continue;
      seenNums.add(e.num);
      const base = { num: e.num, kid: e.kid, ev: e.name };
      const early = p.f === e.firstPoll && !fromStart(e); // registered before tracking began
      const t0 = early ? (e.start || p.f) : p.f;
      items.push({ ...base, t: t0, k: 'seen', first: early, approx: early, b: 1, amt: -(e.buyin || 0) });
      const rt = (p.r || []).slice().sort((a, b) => a - b);
      const extra = Math.max(0, (p.b || 1) - 1);
      const unknown = Math.max(0, extra - rt.length);
      // Re-entries bought before tracking began: the site gives the count but no times, and its bust time is the
      // player's latest bust (after all of them). Keep them in bullet order on the event's first day, time unknown.
      for (let i = 0; i < unknown; i++) items.push({ ...base, t: t0 + i + 1, k: 'reentry', b: i + 2, amt: -(e.buyin || 0), approx: true, unknownTime: true });
      rt.forEach((t, i) => items.push({ ...base, t, k: 'reentry', b: unknown + i + 2, amt: -(e.buyin || 0) }));
      (p.x || []).forEach((t) => items.push({ ...base, t, k: 'bust' }));
      if (p.st === 'end') items.push({ ...base, t: e.doneAt || e.lastPoll, k: 'end' });
    }
    for (const [num, r] of Object.entries(state.results)) for (const [pos, n, , prize] of r.rows) if (canon(state, n) === name) {
      const e = kidsOf(state, num)[0];
      if (!seenNums.has(num)) items.push({ t: (e && e.start) || r.at, approx: true, k: 'buyin', num, ev: e ? e.base : label(num), amt: -buyinOf(state, num) });
      items.push({ t: (r.seen && r.seen[n]) || r.at, k: 'cash', num, ev: e ? e.base : label(num), pos, prize, amt: prize });
    }
    const order = { buyin: 0, seen: 1, reentry: 2, bust: 3, end: 4, cash: 5 };
    items.sort((a, b) => (a.t || 0) - (b.t || 0) || order[a.k] - order[b.k]);
    let bank = 0;
    for (const it of items) { if (it.amt) bank += it.amt; it.bank = bank; }
    return items;
  }

  function liveEvents(state, now) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.polls > 0 && (e.phase !== 'Completed' || now - (e.doneAt || 0) < 3600))
      .map((e) => {
        const ps = Object.values(e.p);
        const bullets = ps.reduce((a, p) => a + (p.b || 1), 0);
        const re = bullets - ps.length;
        return { kid: e.kid, num: e.num, name: e.name, phase: e.phase, start: e.start, regClose: null, regOpen: e.reg === 'OPEN', buyin: e.buyin,
          entries: e.entries, remaining: e.remaining, seated: e.alive, unique: ps.length, reentriesSeen: re, waiting: 0, carried: 0,
          untracked: e.entries == null ? null : Math.max(0, e.entries - bullets), over: e.entries == null ? 0 : Math.max(0, bullets - e.entries),
          laterDay: false, trackedFromStart: fromStart(e), busts: e.entries != null && e.remaining != null ? Math.max(0, e.entries - e.remaining) : ps.filter((p) => p.st === 'x').length,
          firstPoll: e.firstPoll, lastPoll: e.lastPoll, sat: e.sat, ord: e.ord, part: e.partShown, note: e.note, level: e.level, blinds: e.blinds, paid: e.paid };
      })
      .sort((a, b) => (a.phase === 'Completed') - (b.phase === 'Completed') || a.ord - b.ord);
  }

  function eventPlayers(state, kid) {
    const e = state.events[kid]; if (!e) return [];
    const res = new Map(((state.results[e.num] || {}).rows || []).map(([pos, n, cc, prize]) => [n, { pos, prize, cc }]));
    return Object.entries(e.p).map(([k, p]) => {
      const n = personOf(state, k); const r = res.get(n);
      return { name: n, cc: p.cc || (r && r.cc) || '', status: p.st === 's' ? 'seated' : p.st === 'end' ? 'end' : 'busted',
        table: null, seat: null, bullets: p.b || 1, carry: false, won: !!p.won, chips: p.chips || 0, bounties: p.bounties || 0,
        firstSeen: p.f, busts: p.x || [], lastBust: (p.x || [])[(p.x || []).length - 1] || null, atStart: p.f === e.firstPoll,
        pos: r ? r.pos : null, prize: r ? r.prize : null };
    });
  }

  function completedEvents(state) {
    return Object.values(state.events).filter((e) => e.phase === 'Completed' && e.polls)
      .map((e) => {
        const r = state.results[e.num];
        const win = r && r.rows.find((x) => x[0] === 1);
        return { kind: 'event', kid: e.kid, num: e.num, name: e.base, buyin: e.buyin, sat: e.sat, entries: e.entries || 0, prizePool: e.prizePool || 0,
          paid: r ? r.rows.length : 0, final: !!(r && r.final), finished: Math.max(...Object.values(e.p).flatMap((p) => p.x || []), 0) || e.doneAt || e.start || 0,
          tracked: true, ord: e.ord, winner: win ? { name: win[1], cc: win[2], prize: win[3] } : null };
      })
      .sort((a, b) => b.finished - a.finished || b.ord - a.ord);
  }

  function upcoming(state, now, hours) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.phase !== 'Completed' && e.status !== 'IN_PROGRESS' && e.start && e.start > now - 3600 && e.start <= now + (hours || 12) * 3600)
      .sort((a, b) => a.start - b.start || a.ord - b.ord)
      .map((e) => ({ kid: e.kid, num: e.num, name: e.base, start: e.start, buyin: e.buyin, phase: e.phase, sat: e.sat }));
  }

  return { SITE, API, SERIES, SERIES_URL, FESTIVAL, BROWSER_POLL, festTag, slim, mergeStates, feedFromBusts, pickBuyin, usdRate, gql, Q, activeKids, eventPlayers, upcoming, completedEvents, watchedFromStart, eventFinished,
    repair, canon, label, emptyState, pollOnce, applySnapshot, players, playerTimeline, liveEvents, zoned };
});
