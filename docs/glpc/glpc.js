/*
 * GLPC live tracker engine. Shared by the GitHub Actions poller (Node) and the live page (browser).
 *
 * Grand Loyal's tracker API (apitracker.grandloyal.vn, the same public JSON its own pages load) lists,
 * for every event, everyone who registered, each with a stable player id and a busted flag, plus the
 * official entry and rebuy counts. Busts and re-entries are read from changes between snapshots:
 *   - busted flag false -> true: bust (time = the poll that first saw it)
 *   - busted flag true -> false (or the same name registering again): re-entry, bullet + 1, once the
 *     official entry count has gone up since the bust (otherwise it was a floor correction)
 * Official rebuys minus the re-entries we saw = rebuys we could not attribute to a player (bought
 * before tracking began, or bust + rebuy between two polls).
 * Finishing places come from the leaderboard rank, prizes from the payout table (in thousands of VND).
 * Every time the site gives is Vietnam wall-clock time with a "Z" suffix; it is converted to real UTC here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GLPCTracker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SITE = 'https://grandloyal.vn';
  const API = 'https://apitracker.grandloyal.vn';
  const SERIES = 'glpc-vi';
  const SERIES_URL = `${SITE}/series/121`;
  const FROM = '2026-11-18', TO = '2026-11-30'; // series dates, Vietnam time
  const TZ_OFF = 7 * 3600; // Vietnam is UTC+7
  const FEED_CAP = 6000;
  const REG_GRACE = 300; // seconds after the scheduled registration close that a re-entry is still accepted
  const PEND_WAIT = 180; // seconds to wait for the entry count to catch up with a returning player
  const STALL_QUIET = 3 * 3600; // no player change and no level change for this long after reg close = finished
  const STALL_LEVEL = 2 * 3600;
  const ACTIVE = new Set(['Late Reg', 'Running', 'In The Money', 'Final Table', 'Break', 'Reg Open']);

  const nowSec = () => Math.floor(Date.now() / 1000);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // "2026-11-18T10:30:00.000Z" means 10:30 in Vietnam
  const toSec = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) - TZ_OFF : null; };
  const numOf = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };

  // Country ids are the countries-states-cities database ids: 2 letters per id, id 1 first
  const CC = 'AFAXALDZASADAOAIAQAGARAMAWAUATAZBSBHBDBBBYBEBZBJBMBTBOBABWBVBRIOBNBGBFBIKHCMCACVKYCFTDCLCNCXCCCOKMCGCDCKCRCIHRCUCYCZDKDJDMDOTLECEGSVGQEREEETFKFOFJFIFRGFPFTFGAGMGEDEGHGIGRGLGDGPGUGTGGGNGWGYHTHMHNHKHUISINIDIRIQIEILITJMJPJEJOKZKEKIKPKRKWKGLALVLBLSLRLYLILTLUMOMKMGMWMYMVMLMTIMMHMQMRMUYTMXFMMDMCMNMEMSMAMZMMNANRNPBQNLNCNZNINENGNUNFMPNOOMPKPWPSPAPGPYPEPHPNPLPTPRQARERORURWSHKNLCPMVCBLMFWSSMSTSASNRSSCSLSGSKSISBSOZAGSSSESLKSDSRSJSZSECHSYTWTJTZTHTGTKTOTTTNTRTMTCTVUGUAAEGBUSUMUYUZVUVAVEVNVGVIWFEHYEZMZWXKCWSX';
  const ccOf = (id) => { const i = Number(id); if (!(i >= 1 && i <= CC.length / 2)) return ''; const c = CC.substr((i - 1) * 2, 2); return /^[A-Z]{2}$/.test(c) ? c : ''; };

  // "NGUYEN THAI CONG KHANH" -> "Nguyen Thai Cong Khanh"
  const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s\-(/'.])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const KEEP_UP = new Set(['Nlh', 'Plo', 'Gtd', 'Itm', 'Pko', 'Ko', 'Vi', 'Ii', 'Iii', 'Iv', 'Hr']);
  const evTitle = (s) => titleCase(s).replace(/\b\p{L}+\b/gu, (w) => (KEEP_UP.has(w) ? w.toUpperCase() : w));

  /* ---------- event names ---------- */
  // "#1 BIG LAUNCHER EVENT DAY 1A (14% ITM, 10% DAY 2)" -> num "1", base "Big Launcher Event", part "Day 1A"
  // "S1 MEGA SATELLITE BIG LAUNCHER EVENT ( 10 IN 1)" -> num "S1" (satellite)
  // Not "PLAY TO FINAL TABLE" or "LIVESTREAM FINAL TABLE": those are notes on a single-day event
const PART_RE = /(?<!\b(?:TO|LIVESTREAM|LIVE STREAM)\s)\b(DAY\s*\d+\s?[A-Z]?\b|FINAL\s+TABLE|FINAL\s+DAY)/i;
  function parseName(raw) {
    // Typos in the schedule, so flights of one event read the same
    let s = clean(raw).replace(/\bLAUCHER\b/gi, 'LAUNCHER').replace(/\bMAINT\b/gi, 'MAIN').replace(/\bSPECVIAL\b/gi, 'SPECIAL').replace(/\bKICK OF\b/gi, 'KICK OFF').replace(/\bSTARTS EVENT\b/gi, 'STARS EVENT');
    let num = null, sat = false;
    let m = s.match(/^#\s*(\d+)\b/);
    if (m) num = m[1];
    else if ((m = s.match(/^S\s*(\d+)\b/i))) { num = 'S' + m[1]; sat = true; }
    if (m) s = s.slice(m[0].length).replace(/^\s*[-–:]\s*/, '');
    if (/\bSATELLITE\b/i.test(s)) sat = true;
    const noParen = s.replace(/\([^)]*\)?/g, ' ');
    const pm = noParen.match(PART_RE);
    let base = pm ? noParen.slice(0, pm.index) : noParen;
    base = base.split(/\s[-–]\s(?=PLAY|LIVESTREAM|LIVE STREAM|BUY IN|BONUS|GTD|\d)/i)[0];
    base = clean(base).replace(/[\s\-–]+$/, '');
    let part = '';
    if (pm) {
      const p = pm[1].toUpperCase().replace(/\s+/g, ' ');
      const dm = p.match(/^DAY ?(\d+) ?([A-Z]?)$/);
      part = dm ? `Day ${dm[1]}${dm[2]}` : titleCase(p);
    }
    return { num, sat, base: evTitle(base || s), part };
  }
  const isLaterPart = (part) => /^(Day [2-9]|Final)/.test(part || '');
  const isLaterDay = (name) => /\s-\s(Day [2-9]\b|Final Day|Final Table)/.test(name || '');
  const baseName = (name) => clean(name).split(/ - (?=Day \d|Final Day|Final Table)/)[0];
  const ordOf = (num) => { if (num == null) return 9999; const [a, b] = String(num).split('·'); const n = /^S/.test(a) ? 1000 + Number(a.slice(1)) : /^E/.test(a) ? 5000 : Number(a); return (Number.isFinite(n) ? n : 9999) + (b ? Number(b) / 10 : 0); };
  const label = (num) => (num == null ? '' : /^\d/.test(String(num)) ? '#' + num : String(num));

  function emptyState() {
    return { v: 1, series: SERIES, updatedAt: 0, listAt: 0, events: {}, res: {}, results: {}, feed: [], aliases: {} };
  }

  function canon(state, n) {
    let k = 0; while (state.aliases && state.aliases[n] && k++ < 8) n = state.aliases[n];
    return n;
  }
  // Player key within one event -> series-wide name (drops the " (2)" of a namesake)
  const personOf = (state, k) => canon(state, String(k).replace(/ \(\d+\)$/, ''));

  async function getJSON(fetchFn, url) {
    const r = await fetchFn(url);
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} for ${url.replace(API, '')}`);
      err.status = r.status;
      const ra = r.headers && r.headers.get && r.headers.get('retry-after');
      if (ra && !isNaN(Number(ra))) err.retryAfter = Number(ra);
      throw err;
    }
    const j = await r.json();
    if (!j || j.success === false) throw new Error('bad response for ' + url.replace(API, ''));
    return j.data;
  }

  /* ---------- event metadata ---------- */
  // Registration close from "Level 12@16:30" (Vietnam time, on the start day or just after midnight)
  function regCloseOf(timeCloseBuy, startIso) {
    const m = String(timeCloseBuy || '').match(/@\s*(\d{1,2}):(\d{2})/);
    const st = startIso ? Date.parse(startIso) : NaN;
    if (!m || !Number.isFinite(st)) return null;
    const day = Math.floor(st / 86400000) * 86400000;
    let t = day + (Number(m[1]) * 60 + Number(m[2])) * 60000;
    if (t < st - 3600000) t += 86400000;
    return Math.floor(t / 1000) - TZ_OFF;
  }

  function ensureEvent(state, id) {
    return state.events[id] || (state.events[id] = { kid: id, p: {}, ids: {}, polls: 0 });
  }

  function applyNames(e) {
    const pn = parseName(e.raw);
    e.ownNum = pn.num; e.sat = pn.sat; e.base = pn.base; e.part = pn.part;
  }

  function mergeList(state, list, now) {
    for (const x of list || []) {
      if (!x || !x.id) continue;
      const e = ensureEvent(state, String(x.id));
      e.raw = clean(x.eventName); applyNames(e);
      e.status = x.status; e.level = x.currentLevelNumber ?? e.level;
      e.start = toSec(x.startDate); e.startIso = x.startDate;
      e.buyin = numOf(x.buyPrice) ?? e.buyin ?? 0;
      e.gtd = numOf(x.gtd) ?? e.gtd;
      if (x.timeCloseBuy) { e.regCloseLabel = x.timeCloseBuy; e.regCloseSched = regCloseOf(x.timeCloseBuy, x.startDate); }
      e.listed = now;
    }
    state.listAt = now;
    link(state);
  }

  function applyDetail(state, e, d, now) {
    if (!d) return;
    e.raw = clean(d.eventName || e.raw); applyNames(e);
    e.status = d.status;
    if (d.currentLevelNumber != null && d.currentLevelNumber !== e.level) { e.level = d.currentLevelNumber; e.levelAt = now; }
    if (!e.levelAt) e.levelAt = now;
    e.start = toSec(d.startDate) ?? e.start; e.startIso = d.startDate || e.startIso;
    e.buyin = numOf(d.buyPrice) ?? e.buyin ?? 0;
    e.stack = d.buyStack ?? e.stack;
    e.gtd = numOf(d.gtd) ?? e.gtd;
    e.entries = d.totalEntries ?? e.entries ?? null;
    e.buys = d.totalBuy ?? e.buys ?? null;
    e.rebuys = d.totalRebuy ?? e.rebuys ?? null;
    e.remaining = d.activePlayerCount ?? e.remaining ?? null;
    e.prizePool = numOf(d.prizePool) ?? e.prizePool ?? 0;
    e.next = d.multiDayTourId ? String(d.multiDayTourId) : null;
    if (Array.isArray(d.levels) && d.levels.length) {
      e.breaks = d.levels.filter((l) => l.isBreak).map((l) => l.levelNumber);
      const lbl = clean(d.registrationEndsLabel).toLowerCase();
      const L = lbl && d.levels.find((l) => clean(l.levelLabel).toLowerCase() === lbl);
      e.regEndN = L ? L.levelNumber : null;
      // Scheduled close when the list gave none: start + every level before the closing one
      if (L && !e.regCloseSched && e.start) {
        e.regCloseSched = e.start + d.levels.filter((l) => l.levelNumber < L.levelNumber).reduce((a, l) => a + (l.durationMinutes || 0) * 60, 0);
      }
    }
    if (d.registrationEndsLabel) e.regEndLabel = d.registrationEndsLabel;
    e.detAt = now;
    link(state);
  }

  // Event numbers for later days named without one ("MAIN EVENT - DAY 2") come from the flights that feed them
  function link(state) {
    const evs = Object.values(state.events);
    const was = new Map(evs.map((e) => [e.kid, e.num]));
    for (const e of evs) { if (e.raw) applyNames(e); e.num = e.ownNum || null; e.target = false; }
    for (let k = 0; k < 4; k++) for (const e of evs) {
      const n = e.next && state.events[e.next];
      if (!n) continue;
      n.target = true;
      if (!n.num && e.num) n.num = e.num;
    }
    for (const e of evs) {
      if (e.num) continue;
      {
        // Same base name as a numbered event
        const twin = evs.find((x) => x.ownNum && !x.sat && x.base && e.base && x.base.replace(/^Maint?\s/i, 'Main ') === e.base.replace(/^Maint?\s/i, 'Main '));
        e.num = twin ? twin.ownNum : 'E' + e.kid;
      }
    }
    for (const e of evs) e.laterDay = isLaterPart(e.part) || e.target;
    const groups = new Map();
    for (const e of evs) { if (!groups.has(e.num)) groups.set(e.num, []); groups.get(e.num).push(e); }
    for (const kids of groups.values()) {
      kids.sort((a, b) => (a.start || 0) - (b.start || 0) || a.kid.localeCompare(b.kid));
      // A day with no registration close in the schedule, after another day of the same number, continues it
      for (const e of kids) if (!e.laterDay && e.listed && !e.regCloseLabel && kids.some((x) => x !== e && (x.start || 0) < (e.start || 0))) e.laterDay = true;
      const multi = kids.some((e) => e.laterDay || e.part || e.next);
      // The schedule reuses a number for different single-day events (#14 on 20 and 21 Nov): keep them apart
      if (!multi && kids.length > 1) kids.forEach((e, i) => { if (i) e.num = `${e.num}·${i + 1}`; });
      for (const e of kids) {
        let part = e.part;
        if (!part && e.laterDay) part = 'Day 2';
        if (!part && multi && !e.laterDay) part = 'Day 1';
        e.partShown = part;
        e.name = (e.base || e.raw || '') + (part ? ' - ' + part : '');
        e.ord = ordOf(e.num);
      }
    }
    // A later day that just learned its event number: move its feed items along
    const moved = new Map(evs.filter((e) => was.get(e.kid) && was.get(e.kid) !== e.num).map((e) => [e.kid, e.num]));
    if (moved.size) for (const f of state.feed || []) if (moved.has(f.kid)) f.num = moved.get(f.kid);
  }

  const regOpenAt = (e, t) => {
    // The level clock is the truth once it runs: registration ends at the start of the closing level
    if (e.regEndN && e.level > 0) return e.level < e.regEndN;
    return !e.regCloseSched || t <= e.regCloseSched + REG_GRACE;
  };

  function computePhase(e, now) {
    if (e.doneAt) return 'Completed';
    if (e.start && now < e.start && !(e.level > 0)) return 'Reg Open';
    if (regOpenAt(e, now)) return 'Late Reg';
    if (e.breaks && e.breaks.includes(e.level)) return 'Break';
    const paid = e.paid || 0;
    if (paid && e.remaining != null && e.remaining <= paid) return e.remaining <= 9 ? 'Final Table' : 'In The Money';
    return 'Running';
  }

  function pushFeed(state, item) {
    state.feed.push(item);
    if (state.feed.length > FEED_CAP) state.feed.splice(0, state.feed.length - FEED_CAP);
  }
  function undoBust(state, kid, n, p, t) {
    if (t == null) return;
    const i = (p.x || []).lastIndexOf(t); if (i >= 0) p.x.splice(i, 1);
    for (let j = state.feed.length - 1; j >= 0; j--) {
      const f = state.feed[j];
      if (f.kid === kid && f.n === n && f.k === 'bust' && f.t === t) { state.feed.splice(j, 1); break; }
    }
  }
  // Is there an official rebuy not yet attached to anyone? (falls back to "the entry count rose since the bust")
  // A return is a re-entry when the entry count rose since this player's bust AND an official rebuy is still unclaimed
  // (with hundreds of players either alone is weak: someone else's rebuy raises the count; an old missed rebuy stays spare)
  function spareRebuy(e, p, xe) {
    const rose = xe == null || e.entries == null || e.entries > xe;
    if (e.rebuys == null) return rose;
    return rose && e.rebuys > Object.values(e.p || {}).reduce((a, q) => a + Math.max(0, (q.b || 0) - 1), 0);
  }
  function countReentry(state, e, n, p, t, cc) {
    p.b = (p.b || 0) + 1; (p.r || (p.r = [])).push(t);
    pushFeed(state, { t, kid: e.kid, num: e.num, n: personOf(state, n), k: 'reentry', b: p.b, cc: cc || p.cc });
  }

  // A later day's player who bagged chips in an earlier flight or day of the same event
  function carried(state, e, n) {
    if (!e.laterDay) return false;
    return Object.values(state.events).some((x) => x.num === e.num && x.kid !== e.kid && (x.start || 0) < (e.start || Infinity) &&
      x.p && x.p[n] && x.p[n].st !== 'x');
  }

  /* ---------- core diff ---------- */
  // rows: leaderboard [{rank, playerId, playerName, countryId, isBusted}]
  function applySnapshot(state, kid, rows, now) {
    const e = state.events[kid];
    const res = { busts: 0, reentries: 0, entries: 0, skipped: false, changed: false };
    rows = (rows || []).filter((r) => r && r.playerId != null && clean(r.playerName));
    const prevN = Object.keys(e.ids || {}).length;
    if (!rows.length && prevN > 3) { res.skipped = true; return res; }
    if (prevN > 15 && rows.length < prevN * 0.5) { res.skipped = true; return res; }
    e.ids = e.ids || {};
    const first = !e.firstPoll;
    if (first) { e.firstPoll = now; e.entriesAtFirst = e.entries; e.rebuysAtFirst = e.rebuys; }
    if (!regOpenAt(e, now) && !e.regClosedAt) e.regClosedAt = now; // when we first saw registration closed
    const claimed = new Set(); // records taken over by a new registration id in this snapshot
    for (const r of rows) {
      const id = String(r.playerId), name = titleCase(r.playerName), cc = ccOf(r.countryId), busted = !!r.isBusted;
      let k = e.ids[id];
      let p = k && e.p[k];
      // An old registration of a player who has since bought in again under a new id: ignore it
      if (p && p.id && p.id !== id) continue;
      if (p && personOf(state, k) !== canon(state, name) && !e.p[name]) {
        // The floor edited the name: keep the record, follow the new spelling
        e.p[name] = p; delete e.p[k];
        for (const f of state.feed) if (f.kid === kid && f.n === personOf(state, k)) f.n = name;
        (state.aliases || (state.aliases = {}))[personOf(state, k)] = name;
        e.ids[id] = name; k = name;
      }
      let rebuyAsNew = false;
      if (!p) {
        // A new id. Same name as a busted player here = they bought in again under a new registration.
        const same = e.p[name];
        if (same && same.st === 'x' && !claimed.has(name)) { k = name; p = same; rebuyAsNew = true; claimed.add(name); }
        else if (same) { let i = 2; while (e.p[`${name} (${i})`]) i++; k = `${name} (${i})`; }
        else k = name;
        e.ids[id] = k;
      }
      if (!p) {
        // Nobody can buy into a later day that costs nothing: they bagged in a flight we may not have watched
        const c = carried(state, e, name) || (e.laterDay && !e.buyin);
        p = e.p[k] = { id, b: c ? 0 : 1, st: busted ? 'x' : 's', f: now, l: now, x: [], cc, ...(c ? { carry: 1 } : {}) };
        if (busted) {
          if (first) p.pre = 1; // already out when tracking began; bust time unknown
          else { p.x.push(now); p.xe = e.entries; }
        }
        if (!first) {
          res.changed = true;
          if (!c) { res.entries++; pushFeed(state, { t: now, kid, num: e.num, n: personOf(state, k), k: 'entry', b: 1, cc }); }
          if (busted) { res.busts++; pushFeed(state, { t: now, kid, num: e.num, n: personOf(state, k), k: 'bust', b: p.b || 1, cc }); }
        }
        p.rank = r.rank;
        continue;
      }
      if (cc) p.cc = cc;
      p.rank = r.rank;
      p.l = now;
      if (rebuyAsNew) p.id = id;
      if (p.st === 'end') continue;
      if (!busted && p.st === 'x') {
        // Back in: a re-entry if the entry count rose since the bust, otherwise a correction by the floor
        const last = p.x.length ? p.x[p.x.length - 1] : null;
        // With hundreds of players, any rebuy raises the count: only a rebuy nobody has claimed can be this one
        const grew = spareRebuy(e, p, p.xe);
        res.changed = true;
        // After registration has closed (plus a few minutes for a last-second rebuy), a return is always a correction
        const lateOk = regOpenAt(e, now) || (e.regClosedAt && now - e.regClosedAt <= REG_GRACE);
        if (!lateOk || (!grew && !regOpenAt(e, now))) { if (last != null) { undoBust(state, kid, personOf(state, k), p, last); res.busts--; } }
        else if (!grew) p.pend = { t: now, cc, xe: p.xe, bust: last };
        else { countReentry(state, e, k, p, now, cc); res.reentries++; }
        p.st = 's'; delete p.pre;
      } else if (busted && p.st === 's') {
        p.st = 'x'; p.x.push(now); p.xe = e.entries; res.busts++; res.changed = true;
        pushFeed(state, { t: now, kid, num: e.num, n: personOf(state, k), k: 'bust', b: p.b || 1, cc: p.cc });
      }
    }
    // Returns waiting for the entry count: a re-entry once it rises, a correction if it hasn't after PEND_WAIT
    for (const [n, p] of Object.entries(e.p)) {
      if (!p.pend) continue;
      const grew = spareRebuy(e, p, p.pend.xe);
      if (grew) { countReentry(state, e, n, p, p.pend.t, p.pend.cc); res.reentries++; state.feed.sort((a, b) => a.t - b.t); delete p.pend; }
      else if (p.st !== 's' || now - p.pend.t >= PEND_WAIT) { undoBust(state, kid, personOf(state, n), p, p.pend.bust); res.busts--; delete p.pend; }
    }
    if (res.changed || first) e.lastChange = now;
    e.lastPoll = now;
    e.polls = (e.polls || 0) + 1;
    e.alive = Object.values(e.p).filter((p) => p.st === 's').length;
    return res;
  }

  // Finished? All out (the site marks the winner busted too), or a flight whose next day has begun,
  // or nothing moving long after registration closed (day ends and deals leave players "in").
  function settle(state, e, now) {
    const ps = Object.values(e.p || {});
    if (e.doneAt) {
      // Something moved after a quiet-time finish: it was only a long pause
      if (e.doneBy === 'stall' && e.lastChange > e.doneAt) {
        delete e.doneAt; delete e.doneBy; delete e.closed;
        for (const p of ps) if (p.st === 'end' && p.endBy === 'stall') { p.st = 's'; delete p.endBy; }
      } else return;
    }
    if (!e.firstPoll || regOpenAt(e, now)) return;
    const alive = ps.filter((p) => p.st === 's');
    const nx = e.next && state.events[e.next];
    let by = null;
    if (ps.length && !alive.length && (e.entries || ps.length) > 0) by = 'out';
    else if (!e.next && alive.length === 1 && ps.length >= 2 && (e.remaining == null || e.remaining <= 1)) by = 'out';
    else if (e.sat && alive.length && alive.length <= seatsOf(state, e)) by = 'out'; // everyone left has won a seat
    else if (nx && nx.polls > 0 && Object.keys(nx.p || {}).length) by = 'next';
    else if (now - (e.lastChange || now) >= STALL_QUIET && now - (e.levelAt || now) >= STALL_LEVEL) by = 'stall';
    if (!by) return;
    e.doneAt = now; e.doneBy = by;
    if (by === 'out' && !e.next) {
      // Satellite: every player left won a seat
      if (alive.length > 1) { for (const p of alive) { p.st = 'end'; p.won = 1; p.endBy = by; } return; }
      // The last one standing (or rank 1, whom the site also marks busted at the end) won: not a bust
      const w = alive.length === 1 ? Object.entries(e.p).find(([, p]) => p === alive[0]) : Object.entries(e.p).find(([, p]) => p.rank === 1);
      if (w) { const [n, p] = w; if (p.st === 'x') undoBust(state, e.kid, personOf(state, n), p, p.x[p.x.length - 1]); p.st = 'end'; p.won = 1; p.endBy = by; }
    } else for (const p of alive) { p.st = 'end'; p.endBy = by; }
  }

  // Satellite seats = payout places sharing the top prize
  function seatsOf(state, e) {
    const pay = (state.res && state.res[e.kid] && state.res[e.kid].pay) || [];
    return pay.length ? pay.filter((r) => r[1] === pay[0][1]).length : 0;
  }

  /* ---------- payouts ---------- */
  async function fetchPayouts(fetchFn, state, e, now) {
    const rows = await getJSON(fetchFn, `${API}/tournaments/${e.kid}/payouts`);
    const pay = (rows || []).map((r) => [Number(r.rank), Math.round((Number(r.prize) || 0) * 1000)]).filter((r) => r[0] > 0).sort((a, b) => a[0] - b[0]);
    const prev = state.res[e.kid];
    const same = !!prev && JSON.stringify(prev.pay) === JSON.stringify(pay);
    const since = same ? (prev.since || prev.at || now) : now;
    state.res[e.kid] = { at: now, pay, since, final: !!e.doneAt && same && now - since >= 1800 && now - e.doneAt >= 1800 };
    e.paid = pay.length ? Math.max(...pay.map((r) => r[0])) : 0;
    return true;
  }

  // Paid places by event number: [pos, name, cc, prize]
  function buildResults(state) {
    const out = {};
    const byNum = new Map();
    for (const e of Object.values(state.events)) { if (!byNum.has(e.num)) byNum.set(e.num, []); byNum.get(e.num).push(e); }
    for (const [num, kids] of byNum) {
      const rows = []; const seen = {};
      let final = true, any = false, at = 0;
      for (const e of kids) {
        const r = state.res[e.kid];
        if (!r || !r.pay.length) continue;
        any = true; at = Math.max(at, r.at); if (!r.final) final = false;
        const prize = new Map(r.pay);
        for (const [k, p] of Object.entries(e.p || {})) {
          if (p.rank == null || !prize.has(p.rank)) continue;
          // Places are final for players out (or at the end); a live player's rank is only a chip ranking
          // Bagged players (st 'end' in a flight that feeds a later day) are still playing
          if (!(p.st === 'x' || (e.doneAt && p.st === 'end' && !e.next))) continue;
          const n = personOf(state, k);
          rows.push([p.rank, n, p.cc || '', prize.get(p.rank), e.kid]);
          seen[n] = p.x && p.x.length ? p.x[p.x.length - 1] : (e.doneAt || null);
        }
      }
      if (any) out[num] = { at, final, rows: rows.sort((a, b) => a[0] - b[0]), seen };
    }
    state.results = out;
  }

  async function pool(items, n, fn) {
    const out = []; let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (err) { out[k] = { error: String(err && err.message || err), status: err && err.status, retryAfter: err && err.retryAfter }; } } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  function activeKids(state, now) {
    return Object.values(state.events).filter((e) => {
      if (e.closed || !e.start || e.start > now + 300) return false;
      if (e.doneAt) return now - e.doneAt < 3600; // keep watching an hour after the finish
      if (!e.polls && (e.entries === 0 || e.entries == null) && now > e.start + 8 * 3600) return false; // never ran
      return true;
    }).map((e) => e.kid);
  }

  function repair() { return 0; }

  const THROTTLE = new Set([403, 429, 503]);

  /**
   * One polling round. opts: {fetchFn, listEvery, resultsEvery, finalEvery, evEvery, concurrency, crawl}
   */
  async function pollOnce(state, opts = {}) {
    const baseFetch = opts.fetchFn || ((u) => fetch(u, { cache: 'no-store' }));
    const now = nowSec();
    const summary = { at: now, events: 0, busts: 0, reentries: 0, entries: 0, errors: [], requests: 0, throttled: 0, retryAfter: 0, repaired: 0 };
    const fetchFn = (u) => { summary.requests++; return baseFetch(u); };
    const note = (err) => {
      summary.errors.push(err.error || err.message || String(err));
      if (THROTTLE.has(err.status)) { summary.throttled++; summary.retryAfter = Math.max(summary.retryAfter, err.retryAfter || 0); }
    };
    state.res = state.res || {};
    if (!state.listAt || now - state.listAt >= (opts.listEvery || 300) || !Object.keys(state.events).length) {
      try { mergeList(state, await getJSON(fetchFn, `${API}/tournaments?startDate=${FROM}&endDate=${TO}`), now); }
      catch (err) { note({ error: 'list: ' + err.message, status: err.status, retryAfter: err.retryAfter }); }
    }
    const kids = activeKids(state, now);
    // Details of events not running yet: once, then every 30 min in the last day before the start (a few per round)
    const crawl = Object.values(state.events)
      .filter((e) => !kids.includes(e.kid) && !e.closed && (!e.detAt || (e.start && e.start - now < 86400 && e.start > now - 3600 && now - e.detAt >= 1800)))
      .sort((a, b) => (a.detAt || 0) - (b.detAt || 0) || (a.start || 0) - (b.start || 0))
      .slice(0, opts.crawl ?? 4);
    const dets = await pool(crawl, opts.concurrency || 4, async (e) => ({ e, d: await getJSON(fetchFn, `${API}/tournaments/${e.kid}`) }));
    for (const g of dets) { if (!g || g.error) { note(g || { error: 'unknown' }); continue; } applyDetail(state, g.e, g.d, now); }

    const got = await pool(kids, opts.concurrency || 4, async (kid) => {
      const e0 = state.events[kid];
      // Entry counts matter while registration is open (re-entry check); after that, once a minute is enough
      const needEv = !e0.detAt || regOpenAt(e0, now) || now - e0.detAt >= (opts.evEvery || 60) || Object.values(e0.p || {}).some((p) => p.pend);
      const [ev, lb] = await Promise.all([
        needEv ? getJSON(fetchFn, `${API}/tournaments/${kid}`) : Promise.resolve(null),
        getJSON(fetchFn, `${API}/tournaments/${kid}/leaderboard`),
      ]);
      return { kid, ev, lb };
    });
    for (const g of got) {
      if (!g || g.error) { note(g || { error: 'unknown' }); continue; }
      const e = state.events[g.kid];
      if (g.ev) applyDetail(state, e, g.ev, now);
      if (!Array.isArray(g.lb)) continue;
      if (!g.lb.length && !e.polls && !(e.entries > 0)) continue; // nobody registered yet
      const r = applySnapshot(state, g.kid, g.lb, now);
      summary.events++; summary.busts += r.busts; summary.reentries += r.reentries; summary.entries += r.entries;
    }
    for (const e of Object.values(state.events)) if (e.polls) settle(state, e, now);

    // Payouts: often once registration has closed, every finalEvery after the finish until unchanged for 30 min
    const want = Object.values(state.events).filter((e) => {
      if (!e.polls) return false;
      const r = state.res[e.kid];
      if (r && r.final) return false;
      const age = r ? now - r.at : Infinity;
      if (e.doneAt) return now - e.doneAt < 6 * 3600 && age >= (opts.finalEvery || 300);
      if (!kids.includes(e.kid)) return false;
      return age >= (regOpenAt(e, now) ? 600 : (opts.resultsEvery || 60));
    });
    const rs = await pool(want, opts.concurrency || 4, (e) => fetchPayouts(fetchFn, state, e, now));
    for (const r of rs) if (r && r.error) note(r);
    for (const e of Object.values(state.events)) {
      e.phase = computePhase(e, now);
      const r = state.res[e.kid];
      if (e.doneAt && !e.closed && ((r && r.final) || now - e.doneAt >= 6 * 3600)) e.closed = 1;
    }
    buildResults(state);
    state.updatedAt = now;
    return summary;
  }

  /* ---------- derived views ---------- */
  const kidsOf = (state, num) => Object.values(state.events).filter((e) => e.num === String(num));
  const fromStart = (e) => !!(e.firstPoll && e.start && e.firstPoll - e.start < 900);

  function watchedFromStart(state, num, now) {
    now = now || nowSec();
    const kids = kidsOf(state, num);
    // Watched from the start, or every official rebuy is attached to a player (so no bullet is unknown)
    const allSeen = (k) => k.polls > 0 && k.rebuys != null && eventCounts(k).missed === 0;
    return kids.length > 0 && kids.some((k) => k.polls > 0) && kids.every((k) => fromStart(k) || allSeen(k) || (!k.polls && (!k.start || k.start > now)));
  }

  function maxBuyin(state, num) { return Math.max(0, ...kidsOf(state, num).map((e) => e.buyin || 0)); }

  // Re-entries we saw vs official rebuys: the rest could not be attributed
  function eventCounts(e) {
    const ps = Object.values(e.p || {});
    const re = ps.reduce((s, p) => s + Math.max(0, (p.b || 0) - 1), 0);
    const missed = e.rebuys == null ? null : Math.max(0, e.rebuys - re);
    return { ps, re, missed };
  }

  // Every flight and day of this event is over (a multi-day event counts only once its last day has ended).
  // A day that never ran, long past its start, does not hold the event open.
  function eventFinished(state, num, now) {
    now = now || nowSec();
    const kids = kidsOf(state, num);
    return kids.some((e) => e.phase === 'Completed') &&
      kids.every((e) => e.phase === 'Completed' || (!e.polls && e.start && e.start < now - 8 * 3600));
  }

  // opts.fromStart: only events watched from their first minute; opts.finished: only events whose every day has ended
  function players(state, opts = {}) {
    const okCache = new Map();
    const keep = (num) => {
      if (!opts.fromStart && !opts.finished) return true;
      if (!okCache.has(num)) okCache.set(num, (!opts.fromStart || watchedFromStart(state, num)) && (!opts.finished || eventFinished(state, num)));
      return okCache.get(num);
    };
    const map = new Map();
    const get = (n) => map.get(n) || (map.set(n, { name: n, cc: '', nums: new Map(), bullets: 0, buyins: 0, busts: 0, seatedIn: [], lastBust: 0, cashes: [], partial: false }), map.get(n));
    for (const e of Object.values(state.events)) {
      if (!e.p || !keep(e.num)) continue;
      const { missed } = eventCounts(e);
      for (const [k, p] of Object.entries(e.p)) {
        const r = get(personOf(state, k)); if (p.cc) r.cc = p.cc;
        const s = r.nums.get(e.num) || { num: e.num, bullets: 0 };
        s.bullets += p.b || 0; r.nums.set(e.num, s);
        r.bullets += p.b || 0; r.buyins += (p.b || 0) * (e.buyin || 0);
        r.busts += (p.x || []).length + (p.pre ? 1 : 0);
        if (p.st === 's' && e.phase !== 'Completed') r.seatedIn.push(label(e.num));
        const lb = (p.x || [])[(p.x || []).length - 1]; if (lb && lb > r.lastBust) r.lastBust = lb;
        // Joined before we watched while some rebuys are unattributed: they may have fired more
        if (!fromStart(e) && missed && (p.pre || p.f === e.firstPoll)) r.partial = true;
      }
    }
    for (const [num, res] of Object.entries(state.results)) {
      if (!keep(num)) continue;
      for (const [pos, n, cc, prize] of res.rows) {
        const r = get(canon(state, n)); if (!r.cc && cc) r.cc = cc;
        r.cashes.push({ num, pos, prize, cc, final: res.final });
        if (!r.nums.has(num)) { r.nums.set(num, { num, bullets: 1 }); r.bullets += 1; r.buyins += maxBuyin(state, num); r.partial = true; }
      }
    }
    // Seen only as a carry-over into a later day: one bullet in the flight we did not watch
    for (const r of map.values()) for (const s of r.nums.values()) if (s.bullets === 0) { s.bullets = 1; r.bullets += 1; r.buyins += maxBuyin(state, s.num); r.partial = true; }
    const out = [];
    for (const r of map.values()) {
      const prizes = r.cashes.reduce((a, c) => a + c.prize, 0);
      const cashedNums = new Set(r.cashes.map((c) => c.num));
      const entered = r.nums.size;
      out.push({ name: r.name, cc: r.cc, events: entered, bullets: r.bullets, reentries: Math.max(0, r.bullets - entered), busts: r.busts,
        buyins: r.buyins, prizes, net: prizes - r.buyins, cashes: r.cashes.length, itm: r.bullets ? cashedNums.size / r.bullets : 0, itmEvent: entered ? cashedNums.size / entered : 0, // ITM per bullet; per event too
        seatedIn: r.seatedIn, lastBust: r.lastBust || null, partial: r.partial,
        cashedEvents: cashedNums.size, wins: r.cashes.filter((c) => c.pos === 1).length });
    }
    out.sort((a, b) => b.prizes - a.prizes || b.bullets - a.bullets || a.name.localeCompare(b.name));
    return out;
  }

  function pOf(state, e, name) {
    if (!e.p) return null;
    if (e.p[name]) return e.p[name];
    for (const k of Object.keys(e.p)) if (personOf(state, k) === name) return e.p[k];
    return null;
  }

  function cashTime(state, num, name, r) {
    const kids = kidsOf(state, num);
    let bust = 0, end = 0, pre = false;
    for (const e of kids) {
      const p = pOf(state, e, name); if (!p) continue;
      for (const t of p.x || []) if (t > bust) bust = t;
      if (p.pre) pre = true;
      if (p.st === 'end' && (e.doneAt || e.lastPoll) > end) end = e.doneAt || e.lastPoll;
    }
    if (end && end >= bust) return { t: end };
    if (bust) return { t: bust };
    const firsts = kids.filter((x) => x.firstPoll).map((x) => x.firstPoll);
    if (pre && firsts.length) return { t: Math.min(...firsts) - 1, before: true };
    return { t: (r.seen && r.seen[name]) || r.at || 0, approx: true };
  }

  function playerTimeline(state, name) {
    const items = [];
    const nums = new Map();
    const numInfo = (num) => {
      if (!nums.has(num)) {
        const kids = kidsOf(state, num);
        const first = kids.slice().sort((a, b) => (a.start || 0) - (b.start || 0))[0] || {};
        nums.set(num, { bullets: 0, start: first.start || null, name: first.name || label(num), buyin: maxBuyin(state, num) });
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
      else items.push({ ...base, t: p.f, k: 'seen', first: e.firstPoll === p.f, b: 1, amt: bullets ? -(e.buyin || 0) : 0 });
      const rt = (p.r || []).slice().sort((a, b) => a - b);
      for (let i = 0; i < Math.max(0, bullets - 1); i++) items.push({ ...base, t: rt[i] != null ? rt[i] : p.f, k: 'reentry', b: i + 2, amt: -(e.buyin || 0), approxTime: rt[i] == null });
      if (p.pre) items.push({ ...base, t: e.firstPoll, k: 'bust', before: true });
      (p.x || []).forEach((t) => items.push({ ...base, t, k: 'bust' }));
      if (p.st === 'end') items.push({ ...base, t: e.doneAt || e.lastPoll, k: 'end' });
    }
    for (const [num, r] of Object.entries(state.results)) for (const [pos, n, , prize] of r.rows) if (canon(state, n) === name) {
      const info = numInfo(num);
      const ev = baseName(info.name);
      if (info.bullets === 0) { info.bullets = 1; items.push({ t: info.start || r.at, approx: true, k: 'buyin', num, ev, amt: -info.buyin }); }
      items.push({ ...cashTime(state, num, name, r), k: 'cash', num, ev, pos, prize, amt: prize });
    }
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
      .filter((e) => e.polls > 0 && (e.phase !== 'Completed' || now - (e.doneAt || e.lastPoll || 0) < 3600))
      .map((e) => {
        const { ps, re, missed } = eventCounts(e);
        const recent = state.feed.filter((f) => f.kid === e.kid && f.k === 'bust' && now - f.t <= 900).length;
        const seenBusts = ps.reduce((a, p) => a + (p.x || []).length + (p.pre ? 1 : 0), 0);
        const official = e.entries != null && e.remaining != null && !e.laterDay ? Math.max(0, e.entries - e.remaining) : null;
        return { kid: e.kid, num: e.num, name: e.name, phase: e.phase, start: e.start, regClose: e.regCloseSched, buyin: e.buyin,
          entries: e.laterDay ? ps.reduce((a, p) => a + (p.carry ? 1 : p.b || 0), 0) : e.entries,
          remaining: e.remaining, seated: e.alive, unique: ps.filter((p) => !p.carry).length, reentriesSeen: re,
          waiting: 0, carried: ps.filter((p) => p.carry).length,
          untracked: missed, laterDay: !!e.laterDay, over: e.rebuys == null ? 0 : Math.max(0, re - e.rebuys),
          rebuys: e.rebuys, level: e.level, regOpen: e.phase === 'Late Reg' || e.phase === 'Reg Open',
          trackedFromStart: fromStart(e), bustsLast15: recent, busts: official != null ? Math.max(official, seenBusts) : seenBusts,
          firstPoll: e.firstPoll, lastPoll: e.lastPoll, sat: e.sat, ord: e.ord, part: e.partShown };
      })
      .sort((a, b) => (a.phase === 'Completed') - (b.phase === 'Completed') || (b.entries || 0) - (a.entries || 0));
  }

  function eventPlayers(state, kid) {
    const e = state.events[kid]; if (!e) return [];
    const res = new Map(((state.results[e.num] || {}).rows || []).map(([pos, n, cc, prize]) => [canon(state, n), { pos, prize, cc }]));
    const out = Object.entries(e.p || {}).map(([k, p]) => {
      const n = personOf(state, k);
      const r = res.get(n);
      return { name: n, cc: p.cc || (r && r.cc) || '', status: p.st === 's' ? 'seated' : p.st === 'end' ? 'end' : 'busted',
        table: null, seat: null, bullets: p.b || 0, carry: !!p.carry, pre: !!p.pre, won: !!p.won,
        firstSeen: p.f, busts: [...(p.pre ? [null] : []), ...(p.x || [])], lastBust: (p.x || [])[(p.x || []).length - 1] || null,
        atStart: p.f === e.firstPoll, pos: r ? r.pos : null, prize: r ? r.prize : null, rank: p.rank ?? null };
    });
    return out;
  }

  function completedEvents(state) {
    const byNum = new Map();
    for (const e of Object.values(state.events)) { if (!byNum.has(e.num)) byNum.set(e.num, []); byNum.get(e.num).push(e); }
    const out = [];
    for (const [num, kids] of byNum) {
      const played = kids.filter((e) => e.polls > 0 || e.doneAt);
      if (!played.length || !kids.every((e) => e.phase === 'Completed' || (!e.polls && e.start && e.start < nowSec() - 8 * 3600))) continue;
      const r = state.results[num];
      const last = played.slice().sort((a, b) => (b.start || 0) - (a.start || 0))[0];
      const firsts = kids.filter((e) => !e.laterDay);
      const win = r && r.rows.find((x) => x[0] === 1);
      out.push({ kind: 'event', kid: last.kid, num, name: baseName(last.name), buyin: maxBuyin(state, num), sat: kids.some((e) => e.sat),
        entries: firsts.reduce((a, e) => a + (e.entries || 0), 0),
        prizePool: Math.max(0, ...kids.map((e) => e.prizePool || 0)), paid: r ? r.rows.length : 0, final: !!(r && r.final),
        finished: Math.max(0, ...kids.map((e) => e.doneAt || 0)) || last.start || 0, tracked: true, ord: last.ord,
        winner: win ? { name: canon(state, win[1]), cc: win[2], prize: win[3] } : null });
    }
    // Finished flights / days of events still in progress: they bag survivors
    for (const [num, kids] of byNum) {
      if (kids.length < 2 || kids.every((e) => e.phase === 'Completed')) continue;
      for (const e of kids) {
        if (e.phase !== 'Completed') continue;
        const bagged = Object.values(e.p || {}).filter((p) => p.st === 'end').length;
        const next = (e.next && state.events[e.next]) || kids.filter((x) => x.phase !== 'Completed' && (x.start || 0) > (e.start || 0)).sort((a, b) => a.start - b.start)[0];
        out.push({ kind: 'flight', kid: e.kid, num, name: baseName(e.name), part: e.partShown, buyin: e.buyin, sat: e.sat, entries: e.entries || 0,
          bagged, tracked: e.polls > 0, finished: e.doneAt || e.lastPoll || e.start || 0, ord: e.ord,
          next: next ? { kid: next.kid, part: next.partShown || 'next day', start: next.start } : null });
      }
    }
    return out.sort((a, b) => b.finished - a.finished || b.ord - a.ord);
  }

  function upcoming(state, now, hours) {
    now = now || nowSec();
    return Object.values(state.events)
      .filter((e) => e.phase !== 'Completed' && !e.polls && e.start && e.start > now - 900 && e.start <= now + (hours || 12) * 3600)
      .sort((a, b) => a.start - b.start || a.ord - b.ord)
      .map((e) => ({ kid: e.kid, num: e.num, name: e.name, start: e.start, buyin: e.buyin, phase: e.phase, sat: e.sat, gtd: e.gtd, regClose: e.regCloseSched }));
  }

  return { SITE, API, SERIES, SERIES_URL, ACTIVE, TZ_OFF, activeKids, eventFinished, eventPlayers, upcoming, completedEvents, watchedFromStart, repair, baseName, canon,
    emptyState, pollOnce, applySnapshot, applyDetail, mergeList, settle, buildResults, players, playerTimeline, liveEvents, isLaterDay, parseName, label, ccOf, regCloseOf, titleCase };
});
