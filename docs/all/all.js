/*
 * All series: every event the trackers hold (APT, GLPC, every Triton festival) as one list of players and events.
 * Each series is counted by its own engine (players(..., { detail: true }) gives every player's events); this page
 * converts the amounts to one currency at each date's rate and matches players across series by name and country.
 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  };
  const LS_PREFS = 'all-series-prefs-v1';

  // Where the trackers' saves live: ?repo=owner/name, else derived from <owner>.github.io/<repo>/
  function repoSlug() {
    const q = new URLSearchParams(location.search).get('repo');
    if (q && /^[\w.-]+\/[\w.-]+$/.test(q)) return q;
    const m = location.hostname.match(/^([\w-]+)\.github\.io$/);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg ? `${m[1]}/${seg}` : null;
  }
  const REPO = repoSlug();
  const REPO_Q = new URLSearchParams(location.search).get('repo'); // carried on links when given (local testing)
  const withRepo = (url) => (REPO_Q ? url + (url.includes('?') ? '&' : '?') + 'repo=' + encodeURIComponent(REPO_Q) : url);

  // on: which organisers count (every organiser is on until switched off)
  const prefs0 = Object.assign({ tab: 'players', sort: 'prizes', sortDir: 'desc', on: {}, year: '', finished: false, known: false, country: '', evSort: 'date' },
    (() => { try { return JSON.parse(store.get(LS_PREFS) || '{}'); } catch { return {}; } })());
  const ORG = Series.ORGANISERS, T = window.TritonTracker;
  // How an organiser's events read, where it differs from the defaults (one entry per event number, the name as is,
  // amounts in the series' currency). name: an event's name without its flight or day; isLater: a later day (Day 2,
  // Final Day) whose players came through earlier flights; laterCovers: a later day's entry count covers every flight.
  const ADAPT = {
    apt: { name: (e, E) => E.baseName(e.name), isLater: (e, E) => E.isLaterDay(e.name), laterCovers: true, nat: (e, s) => e.currency || s.currency },
    gop: { name: (e, E) => E.baseName(e.name), isLater: (e, E) => E.isLaterDay(e.name), laterCovers: true, nat: (e, s) => e.currency || s.currency },
    glpc: { name: (e, E) => E.baseName(e.name), isLater: (e) => !!e.laterDay },
    triton: { nat: (e) => e.cur || 'USD' },
  };
  const adapt = (org) => ({ name: (e) => e.base || e.name, isLater: () => false, laterCovers: false, nat: (e, s) => e.currency || s.currency || 'USD', ...(ADAPT[org] || {}) });
  // One source per series in docs/series.js; Triton's festivals are one source (its archive plus those still tracked).
  // key: source id; page: its tracker (Triton: the all-time view, which holds every festival)
  const SRC = [];
  for (const x of Series.LIST) {
    if (x.org === 'triton' || Series.status(x) === 'soon') continue; // nothing saved before it starts
    const E = window[ORG[x.org].global];
    if (!E) { console.warn(`${x.id}: add a <script> for ${ORG[x.org].engine} to this page`); continue; }
    SRC.push({ id: x.id, org: x.org, entry: x, E, branch: x.branch, name: x.name, short: ORG[x.org].name, tag: x.tag || '', page: Series.pageUrl(x, '../') });
  }
  SRC.push({ id: 'triton', org: 'triton', entry: {}, E: T, name: 'Triton', short: 'Triton', tag: '', page: '../triton/?view=all', all: true });
  for (const s of SRC) { s.ad = adapt(s.org); s.nat = (e) => s.ad.nat(e, s.entry); }
  const SRC_BY = Object.fromEntries(SRC.map((s) => [s.id, s]));
  let ORGS = [...new Set(SRC.map((s) => s.org))];
  const prefs = prefs0;
  for (const o of ORGS) if (prefs.on[o] == null) prefs.on[o] = true;

  const savePrefs = () => store.set(LS_PREFS, JSON.stringify(prefs));

  // Dark by default; remembered on this device
  function applyTheme() {
    const t = prefs.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#0b0d12' : '#f5f1e6';
    const b = $('#theme'), lab = document.createElement('span'), ic = document.createElement('small');
    lab.textContent = t === 'dark' ? 'Light mode' : 'Dark mode'; ic.textContent = t === 'dark' ? '☀' : '☾';
    b.replaceChildren(lab, ic);
    b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  applyTheme();
  $('#theme').addEventListener('click', () => { prefs.theme = prefs.theme === 'light' ? 'dark' : 'light'; savePrefs(); applyTheme(); if (openRef) openPerson(openRef); });

  /* ---------- formatting ---------- */
  const nf = new Intl.NumberFormat('en-US');
  const fDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  const fDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const plainShort = (v) => {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 1 : 2).replace(/\.?0+$/, '') + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (a >= 1e5) return s + Math.round(a / 1e3) + 'K';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return s + Math.round(a);
  };
  const CUR_SYM = { USD: '$', EUR: '€', GBP: '£', THB: '฿', TWD: 'NT$', VND: '₫', HKD: 'HK$', CNY: 'CN¥', JPY: '¥', KRW: '₩', SGD: 'S$', AUD: 'A$', MYR: 'RM', PHP: '₱', INR: '₹', CAD: 'C$' };
  const curSym = () => { const c = fxShown || fxCur; return CUR_SYM[c] || c + ' '; };
  const short = (v) => (v < 0 ? '−' : '') + curSym() + plainShort(Math.abs(v));
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + short(Math.abs(v));
  const money = (v) => (v < 0 ? '−' : '') + curSym() + nf.format(Math.round(Math.abs(v || 0)));
  const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
  const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + '%' : '—');
  const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc)) ? String.fromCodePoint(...[...cc].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
  const withFlag = (cc, name) => (flag(cc) ? flag(cc) + ' ' : '') + name;
  const ago = (t) => { const s = Math.max(0, Math.round(Date.now() / 1000 - t)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const regionName = (() => { try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); return (cc) => { try { return d.of(cc) || cc; } catch { return cc; } }; } catch { return (cc) => cc; } })();
  // Organiser label, coloured per organiser, with the series or festival ("APT Taipei '26", "Triton ×9")
  const stag = (key, extra) => { const s = SRC_BY[key], x = extra == null ? s.tag : extra; return el('span', 'stag ' + s.org, s.short + (x ? ' ' + x : '')); };
  // Short event name: no "[Event 1]", guarantee or sponsor notes
  const cleanName = (n) => String(n || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/\s*[-–]\s*Sponsored by\b.*$/i, '')
    .replace(/\s*[-–]\s*(?:[A-Z]{3}\s*)?[\d.,]+\s*(M|K)?\s*GTD\b.*$/i, '')
    .replace(/\s*\([^)]{18,}\)\s*$/, '').replace(/\s+/g, ' ').trim(); // and no long rule notes in brackets at the end
  const tile = (parent, k, v, sub, cls) => {
    const d = el('div'); d.appendChild(el('div', 'k', k)); d.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
    if (sub) d.appendChild(el('div', 's', sub)); parent.appendChild(d); return d;
  };
  const groupBox = (box, groups) => {
    for (const [title, tiles] of groups) {
      const g = el('div', 'sum-group'); g.appendChild(el('h3', '', title));
      const grid = el('div', 'sum-grid');
      for (const [k, v, sub, cls] of tiles) tile(grid, k, v, sub, cls);
      g.appendChild(grid); box.appendChild(g);
    }
  };

  /* ---------- loading ---------- */
  const raws = {}, savedAt = {}, shas = {}, errors = {};
  let tritonAll = null; const tritonLive = {};
  async function fetchBranch(branch) {
    let url = `https://raw.githubusercontent.com/${REPO}/${branch}/state.json?t=${Math.floor(Date.now() / 60000)}`;
    try {
      const g = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${branch}`, { cache: 'no-cache', headers: { Accept: 'application/vnd.github+json' } });
      if (g.ok) {
        const sha = ((await g.json()).object || {}).sha;
        if (sha && sha === shas[branch]) return null; // nothing new
        if (sha) { url = `https://raw.githubusercontent.com/${REPO}/${sha}/state.json`; shas[branch] = sha; }
      }
    } catch {}
    const r = await fetch(url, { cache: url.includes('?') ? 'no-store' : 'default' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function loadSrc(s) {
    try {
      if (s.all) {
        // Every past festival in one file (tools/triton-archive.js), plus the festivals in docs/series.js not archived
        // yet, from their data branches
        const tracked = REPO ? Series.ofOrg('triton').filter((x) => Series.status(x) !== 'soon') : [];
        const [all, ...lives] = await Promise.all([
          tritonAll || fetch('../triton/archive/all.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
          ...tracked.map((x) => fetchBranch(x.branch).catch(() => null))]);
        const fresh = !tritonAll || lives.some(Boolean);
        if (!tritonAll) { tritonAll = T.unpack(all); FX.seed(all.fx); }
        if (!fresh) return false;
        const archived = new Set((tritonAll.index || []).map((f) => f.id));
        tracked.forEach((x, i) => { if (lives[i]) tritonLive[x.id] = lives[i]; });
        const parts = [{ state: tritonAll }];
        let at = tritonAll.updatedAt || 0;
        for (const lv of Object.values(tritonLive)) {
          if (!lv.festival || archived.has(lv.festivalId)) continue;
          parts.unshift({ state: lv, tag: T.festTag(lv.festival.name, lv.festival.startDate), start: lv.festival.startDate });
          at = Math.max(at, lv.updatedAt || 0);
        }
        raws.triton = T.mergeStates(parts);
        savedAt.triton = at;
      } else if (s.file) {
        // A past series saved by its organiser's archive tool: loaded once
        if (raws[s.id]) return false;
        const r = await fetch(s.file);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const st = await r.json(); if (s.E.unpack) s.E.unpack(st); s.E.repair(st); raws[s.id] = st;
      } else {
        if (!REPO) return false;
        const st = await fetchBranch(s.branch);
        if (!st) return false;
        s.E.repair(st);
        raws[s.id] = st; savedAt[s.id] = st.updatedAt;
      }
      delete errors[s.id];
      return true;
    } catch (e) { errors[s.id] = String(e.message || e); return false; }
  }
  // Past series of the organisers with a series archive (APT, GOP: tools/<org>-archive.js) join as sources of their own,
  // unless still a live entry in docs/series.js
  let archivesAdded = false;
  async function addArchives() {
    if (archivesAdded) return []; archivesAdded = true;
    const added = [];
    const orgs = Object.keys(ORG).filter((o) => ORG[o].archive && ORG[o].archive.list === 'series' && window[ORG[o].global]);
    await Promise.all(orgs.map(async (o) => {
      const dir = '../' + ORG[o].archive.dir;
      try {
        const [idx, fx] = await Promise.all([fetch(dir + 'index.json').then((r) => r.json()), fetch(dir + 'fx.json').then((r) => r.json()).catch(() => null)]);
        FX.seed(fx); // their dates' rates, saved with them
        for (const f of idx.series || []) {
          const dup = SRC.find((x) => x.org === o && x.entry.source && x.entry.source.series === f.id);
          if (dup) SRC.splice(SRC.indexOf(dup), 1); // archived since: the saved file replaces the live record
          const s = { id: `${o}:${f.id}`, org: o, entry: { currency: f.currency }, E: window[ORG[o].global], name: f.name, short: ORG[o].name, tag: f.tag,
            page: `../${ORG[o].page}?f=${encodeURIComponent(f.id)}`, file: `${dir}${f.id}.json`, archived: true };
          s.ad = adapt(s.org); s.nat = (e) => s.ad.nat(e, s.entry);
          SRC.push(s); SRC_BY[s.id] = s; added.push(s);
        }
      } catch (e) { console.warn(`${ORG[o].name} archive unavailable`, e); }
    }));
    ORGS = [...new Set(SRC.map((s) => s.org))];
    for (const o of ORGS) if (prefs.on[o] == null) prefs.on[o] = true;
    fillSrcChips();
    return added;
  }
  let loading = false;
  async function loadAll() {
    if (loading) return; loading = true; setStatus();
    // Live series show as soon as each arrives; the past APT series all at once
    // Hand-made fixes to who is who (docs/people.json, see docs/people.js)
    const fixes = fetch('../people.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => {
      if (!j) return; RULES = People.rules(j); for (const x of RULES.problems) console.warn('people.json:', x);
      model = null; if (views) render();
    });
    const live = Promise.all(SRC.map((s) => loadSrc(s).then((changed) => { if (changed) recompute(); })));
    const past = addArchives().then((added) => Promise.all(added.map(loadSrc))).then((ch) => { if (ch.some(Boolean)) recompute(); });
    await Promise.all([live, past, fixes]);
    loading = false; setStatus();
  }

  /* ---------- currency ---------- */
  let fxCur = FX.pick() || 'USD'; // several currencies at once: one has to be picked
  let fxShown = '', fxBusy = false, fxTried = '';
  const evEnd = (e) => e.doneAt || e.lastPoll || e.start;
  function fillFx() { $('#fx').replaceChildren(...FX.LIST.map((c) => new Option(c, c))); $('#fx').value = fxCur; }
  $('#fx').addEventListener('change', (e) => { fxCur = e.target.value; FX.choose(fxCur); fxTried = ''; recompute(); });
  // A converted copy of a series: buy-ins at each event's start date, prizes at its finish date
  function display(s, src) {
    const out = { ...src, events: {}, results: {} }, byNum = new Map();
    let ok = true, approx = false;
    const fac = (from, d) => {
      let f = FX.factor(from, fxCur, d);
      if (f != null && !FX.exact(from, fxCur, d)) approx = true;
      if (f == null && s.org === 'triton' && fxCur === 'USD') { f = T.usdRate(from, d); approx = true; }
      if (f == null) ok = false;
      return f == null ? 1 : f;
    };
    // A currency with no rate at all (an unknown code) falls back to the series' own, so one bad event can't blank the page
    const natOf = (e) => { const c = s.nat(e); return FX.perUsd(c, '2025-01-01') == null && s.entry.currency && FX.perUsd(s.entry.currency, '2025-01-01') != null ? s.entry.currency : c; };
    for (const [k, e] of Object.entries(src.events || {})) {
      const from = natOf(e), f = fac(from, FX.ymd(e.start || src.updatedAt || Date.now() / 1000));
      out.events[k] = f === 1 ? e : { ...e, buyin: Math.round((e.buyin || 0) * f), prizePool: Math.round((e.prizePool || 0) * f), ...(e.gtd ? { gtd: Math.round(e.gtd * f) } : {}) };
      const key = String(e.num), end = evEnd(e) || 0, cur = byNum.get(key);
      if (!cur || end > cur.end) byNum.set(key, { end, from });
    }
    for (const [num, r] of Object.entries(src.results || {})) {
      const info = byNum.get(String(num));
      if (!info) { out.results[num] = r; continue; }
      const f = fac(info.from, FX.ymd(info.end || src.updatedAt || Date.now() / 1000));
      out.results[num] = f === 1 ? r : { ...r, rows: r.rows.map((row) => [row[0], row[1], row[2], Math.round(row[3] * f), ...row.slice(4)]) };
    }
    return { s: out, ok, approx };
  }
  function needRates() {
    // Each date needs only its own event's currency and the one shown (not every currency on every date: Triton's
    // dollar festivals need no Taiwan dollar rates, and each of those is a request of its own)
    const byCur = new Map(), add = (c, d) => { if (!byCur.has(c)) byCur.set(c, new Set()); byCur.get(c).add(d); };
    let n = 0;
    for (const s of SRC) for (const e of Object.values((raws[s.id] || {}).events || {})) {
      if (!e.polls && !e.start) continue;
      const nat = s.nat(e);
      for (const t of [e.start, evEnd(e)]) if (t) { const d = FX.ymd(t); n++; if (nat !== fxCur) { add(nat, d); add(fxCur, d); } }
    }
    const sig = fxCur + '|' + n;
    if (fxBusy || fxTried === sig) return;
    fxBusy = true; fxTried = sig; setStatus();
    // ECB currencies together (one request covers a run of dates for all of them); the others one by one
    const ecb = [...byCur.keys()].filter((c) => FX.ECB.has(c)), ecbDays = new Set(ecb.flatMap((c) => [...byCur.get(c)]));
    const jobs = [ecb.length && FX.ensure([...ecbDays], ecb), ...[...byCur].filter(([c]) => !FX.ECB.has(c)).map(([c, ds]) => FX.ensure([...ds], [c]))];
    Promise.all(jobs.filter(Boolean).map((p) => p.catch(() => {}))).then(() => { fxBusy = false; recompute(); });
  }

  /* ---------- events of every series ---------- */
  let views = null, evIdx = {}; // converted states; per series: num -> event summary
  const yearOf = (t) => (t ? String(new Date(t * 1000).getFullYear()) : '');
  function eventsOf(s, v) {
    const E = s.E, byNum = new Map(), out = new Map();
    for (const e of Object.values(v.events || {})) { const k = String(e.num); if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(e); }
    const done = new Map(E.completedEvents(v).filter((x) => x.kind === 'event').map((x) => [String(x.num), x]));
    for (const [num, kids] of byNum) {
      const res = v.results[num];
      if (!kids.some((e) => e.polls > 0) && !(res && res.rows.length)) continue; // listed, never played or watched
      const c = done.get(num);
      const byStart = kids.slice().sort((a, b) => (a.start || 0) - (b.start || 0));
      const first = byStart[0], last = byStart[byStart.length - 1];
      const nameOf = (e) => cleanName(s.ad.name(e, E));
      // Flights add up; a later day's entry count covers every flight (APT) or only players carried over (GLPC)
      const later = kids.filter((e) => s.ad.isLater(e, E));
      const entries = c ? c.entries : later.length && s.ad.laterCovers ? Math.max(...later.map((e) => e.entries || 0)) : kids.filter((e) => !later.includes(e)).reduce((a, e) => a + (e.entries || 0), 0);
      const win = res && res.rows.find((x) => x[0] === 1);
      const finished = E.eventFinished(v, num);
      const [n0, fest] = String(num).split('@');
      out.set(num, { src: s.id, num, kid: (c && c.kid) || last.kid, name: c ? cleanName(c.name) : nameOf(last), label: /^\d/.test(n0) ? '#' + n0 : n0, fest: s.all ? fest || '' : s.tag,
        start: first.start || 0, end: (c && c.finished) || Math.max(...kids.map((e) => evEnd(e) || 0)), buyin: Math.max(0, ...kids.map((e) => e.buyin || 0)),
        entries: entries || 0, pool: Math.max(0, ...kids.map((e) => e.prizePool || 0)) || (res ? res.rows.reduce((a, r) => a + r[3], 0) : 0),
        paid: res ? res.rows.length : 0, finished, known: E.watchedFromStart(v, num),
        winner: win ? { name: win[1], cc: win[2], prize: win[3] } : null, year: yearOf(first.start) });
    }
    return out;
  }

  // Sources arrive one by one: redraw once for those landing close together
  let recomputeTimer = null;
  function recompute() { if (!recomputeTimer) recomputeTimer = setTimeout(() => { recomputeTimer = null; recomputeNow(); }, 60); }
  // A series' converted copy, kept until its data, the currency or the rates change
  const shown = new WeakMap(), used = new WeakMap();
  function displayed(s, raw) {
    // Only rates that can change its amounts matter: its own currencies and the one shown, in the months around its
    // events (a rate is looked for within a week); one that fell back to a far day's rate watches the whole currency
    let u = used.get(raw);
    if (!u) {
      const cs = new Set(), ms = new Set();
      const month = (t) => { const d = new Date(t * 1000); for (const k of [-1, 0, 1]) ms.add(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1)).toISOString().slice(0, 7)); };
      for (const e of Object.values(raw.events || {})) { cs.add(s.nat(e)); for (const t of [e.start, evEnd(e)]) if (t) month(t); }
      month(Date.now() / 1000); // a future date uses today's rate
      u = { cs: [...cs], ms: [...ms] }; used.set(raw, u);
    }
    const curs = u.cs.every((c) => c === fxCur) ? [] : [fxCur, ...u.cs];
    const near = curs.map((c) => c + u.ms.map((m) => FX.version(c, m)).join('.')).join(','), far = curs.map((c) => c + FX.version(c)).join(',');
    const hit = shown.get(raw);
    if (hit && hit.cur === fxCur && (hit.d.approx ? hit.far === far : hit.near === near)) return hit.d;
    const d = display(s, raw); shown.set(raw, { cur: fxCur, near, far, d }); return d;
  }
  function recomputeNow() {
    const v = {}; let ok = true, approx = false;
    for (const s of SRC) if (raws[s.id]) { const d = displayed(s, raws[s.id]); v[s.id] = d.s; ok = ok && d.ok; approx = approx || d.approx; }
    if (!Object.keys(v).length) { setStatus(); return; }
    if (ok || !views) {
      // Until a new currency's rates load, keep showing the previous one (or nothing, the very first time)
      if (ok) { views = v; fxShown = fxCur; evIdx = {}; for (const s of SRC) if (v[s.id]) evIdx[s.id] = eventsOf(s, v[s.id]); }
    }
    if (!ok || approx) needRates();
    model = null;
    fillYears(); render();
  }

  /* ---------- players across series ---------- */
  // One key per name in any word order, without accents, hyphens or case: "Chen Kuan-Han" = "Kuan Han Chen"
  const norm = People.norm;
  let RULES = People.rules(null);
  // What docs/people.json may call a source: its id, its organiser, and a past APT series' slug (also as the live entry it was)
  const calledOf = (s) => {
    const slug = s.archived ? s.id.slice(s.org.length + 1) : s.entry && s.entry.source && s.entry.source.series;
    const entry = slug && Series.LIST.find((x) => x.org === s.org && x.source.series === slug);
    return [s.org, slug, entry && entry.id].filter(Boolean);
  };
  const evOk = (sid) => { const y = prefs.year; return (num) => !y || ((evIdx[sid] || new Map()).get(String(num)) || {}).year === y; };
  // A series' state with only the picked year's events (finished / all bullets known go to the engine itself)
  function scope(s, v) {
    if (!prefs.year) return v;
    const ok = evOk(s.id), out = { ...v, events: {}, results: {} };
    for (const [k, e] of Object.entries(v.events || {})) if (ok(e.num)) out.events[k] = e;
    for (const [n, r] of Object.entries(v.results || {})) if (ok(n)) out.results[n] = r;
    return out;
  }
  let model = null;
  // A series' player rows for the current filters, kept with its converted copy (a new series doesn't recount the others)
  const rowCache = new WeakMap();
  function rowsOf(s, v) {
    const key = [prefs.year || '', prefs.known ? 1 : 0, prefs.finished ? 1 : 0].join('|');
    let m = rowCache.get(v); if (!m) rowCache.set(v, (m = new Map()));
    if (!m.has(key)) m.set(key, s.E.players(scope(s, v), { detail: true, fromStart: !!prefs.known, finished: !!prefs.finished }).filter((r) => r.events));
    return m.get(key);
  }
  function getModel() {
    if (model) return model;
    // Same person: same name key, one row per series, countries that agree (or one unknown); docs/people.json fixes the rest
    const lists = SRC.filter((s) => views && views[s.id] && prefs.on[s.org]).map((s) => ({ src: s.id, names: calledOf(s),
      rows: rowsOf(s, views[s.id]) }));
    const people = People.match(lists, RULES);
    for (const p of people) {
      const rows = Object.values(p.rows);
      const sum = (f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
      const main = rows.slice().sort((a, b) => b.bullets - a.bullets)[0];
      Object.assign(p, { name: main.name, series: rows.length, events: sum((r) => r.events), bullets: sum((r) => r.bullets), buyins: sum((r) => r.buyins), prizes: sum((r) => r.prizes),
        cashes: sum((r) => r.cashes), cashedEvents: sum((r) => r.cashedEvents), wins: sum((r) => r.wins), partial: rows.some((r) => r.partial),
        seated: rows.some((r) => r.seatedIn && r.seatedIn.length), names: [...new Set(rows.flatMap((r) => r.names || [r.name]))] });
      p.keys = [...new Set(p.names.map(norm))]; // every spelling, for search
      p.net = p.prizes - p.buyins; p.itm = p.bullets ? p.cashedEvents / p.bullets : 0;
      p.fests = p.rows.triton ? new Set(p.rows.triton.ev.map((d) => String(d.num).split('@')[1])).size : 0;
    }
    people.sort((a, b) => b.prizes - a.prizes || b.bullets - a.bullets || a.name.localeCompare(b.name));
    return (model = people);
  }

  /* ---------- filters ---------- */
  function fillSrcChips() {
    const box = $('#src-chips'); box.replaceChildren();
    for (const o of ORGS) {
      const b = el('button', 'chip src ' + o, ORG[o].name); b.type = 'button'; b.setAttribute('aria-pressed', String(!!prefs.on[o]));
      b.title = SRC.filter((s) => s.org === o).map((s) => s.name).join(', ');
      b.addEventListener('click', () => {
        prefs.on[o] = !prefs.on[o];
        if (!ORGS.some((x) => prefs.on[x])) prefs.on[o] = true; // at least one organiser
        savePrefs(); fillSrcChips(); filtersChanged();
      });
      box.appendChild(b);
    }
  }
  function fillYears() {
    const ys = new Set(); for (const m of Object.values(evIdx)) for (const e of m.values()) if (e.year) ys.add(e.year);
    const list = [...ys].sort().reverse(), sel = $('#year'), sig = list.join(',');
    if (sel.dataset.sig !== sig) { sel.replaceChildren(new Option('Every year', ''), ...list.map((y) => new Option(y, y))); sel.dataset.sig = sig; }
    sel.value = prefs.year || '';
  }
  function syncToggles() {
    $('#f-finished').checked = $('#sheet-finished').checked = !!prefs.finished;
    $('#f-known').checked = $('#sheet-known').checked = !!prefs.known;
  }
  function filtersChanged() { model = null; savePrefs(); syncToggles(); playersLimit = 60; eventsLimit = 100; render(); }
  $('#year').addEventListener('change', (e) => { prefs.year = e.target.value; filtersChanged(); });
  for (const [id, k] of [['#f-finished', 'finished'], ['#sheet-finished', 'finished'], ['#f-known', 'known'], ['#sheet-known', 'known']])
    $(id).addEventListener('change', (e) => { prefs[k] = e.target.checked; filtersChanged(); });

  /* ---------- players tab ---------- */
  let playersLimit = 60, eventsLimit = 100;
  function fillCountries(sel, ccs) {
    const counts = new Map();
    for (const cc of ccs) if (cc && /^[A-Z]{2}$/.test(cc)) counts.set(cc, (counts.get(cc) || 0) + 1);
    if (prefs.country && !counts.has(prefs.country)) counts.set(prefs.country, 0);
    const list = [...counts].sort((a, b) => b[1] - a[1] || regionName(a[0]).localeCompare(regionName(b[0])));
    const sig = list.map(([c, n]) => c + n).join(',');
    if (sel.dataset.sig !== sig) { sel.replaceChildren(new Option('All countries', ''), ...list.map(([cc, n]) => new Option(`${flag(cc)} ${regionName(cc)} (${n})`, cc))); sel.dataset.sig = sig; }
    sel.value = prefs.country || '';
  }
  function seriesTags(p) {
    const box = el('span', 'stags');
    // One tag per organiser: its series' name when one, "×n" when several (Triton: festivals)
    for (const o of ORGS) {
      const mine = SRC.filter((s) => s.org === o && p.rows[s.id]); if (!mine.length) continue;
      const n = mine.reduce((a, s) => a + (s.all ? p.fests || 1 : 1), 0);
      box.appendChild(stag(mine[0].id, n > 1 ? '×' + n : mine[0].all ? '' : null));
    }
    return box;
  }
  function renderSummary(rows, q) {
    const sum = (f) => rows.reduce((a, p) => a + (f(p) || 0), 0);
    const n = rows.length, bullets = sum((p) => p.bullets), entered = sum((p) => p.events);
    const buyins = sum((p) => p.buyins), prizes = sum((p) => p.prizes), net = prizes - buyins;
    const cashes = sum((p) => p.cashes), cashedEvents = sum((p) => p.cashedEvents), wins = sum((p) => p.wins);
    const multi = rows.filter((p) => p.series > 1).length, winners = rows.filter((p) => p.net > 0).length, losers = rows.filter((p) => p.net < 0).length;
    const partial = rows.some((p) => p.partial);
    const box = $('#players-summary'); box.replaceChildren();
    groupBox(box, [
      ['Field', [['Players', nf.format(n), multi ? nf.format(multi) + ' in 2+ series' : ''], ['Bullets', (partial ? '≥' : '') + nf.format(bullets), n ? (bullets / n).toFixed(2) + ' each' : ''],
        ['Re-entries', (partial ? '≥' : '') + nf.format(Math.max(0, bullets - entered)), pct(bullets - entered, entered)]]],
      ['Money', [['Buy-in', (partial ? '≥' : '') + short(buyins), n ? short(buyins / n) + ' each' : ''], ['Prizes', short(prizes), cashes ? short(prizes / cashes) + ' per cash' : '', 'gold'],
        ['Net', signed(net), buyins ? 'ROI ' + pct(net, buyins) : '', net > 0 ? 'pos' : net < 0 ? 'neg' : '']]],
      ['Results', [['Cashes', nf.format(cashes), wins ? plural(wins, 'win', 'wins') : ''], ['ITM', (partial ? '≤' : '') + pct(cashedEvents, bullets), `${nf.format(cashedEvents)}/${nf.format(bullets)} bullets`],
        ['Cashing players', nf.format(rows.filter((p) => p.cashes > 0).length), ''], ['Winning', pct(winners, n), nf.format(winners) + ' players', 'pos'], ['Losing', pct(losers, n), nf.format(losers) + ' players', 'neg']]],
    ]);
    // The same players split by organiser (each opens to its series)
    const g = el('div', 'sum-group'); g.appendChild(el('h3', '', 'By series'));
    const t = el('table', 'gtable flat');
    t.innerHTML = '<thead><tr><th>Series</th><th>Players</th><th>Bullets</th><th>Buy-in</th><th>Prizes</th></tr></thead>';
    const tb = el('tbody');
    const used = SRC.filter((s) => rows.some((p) => p.rows[s.id]));
    fillGrouped(tb, used, (s, under) => (under ? Object.assign(el('span', 'stag ' + s.org, s.tag || s.name), { title: s.name }) : stag(s.id, s.all ? '' : null)), (list, label) => {
      const ps = rows.filter((p) => list.some((s) => p.rows[s.id]));
      const rs = ps.flatMap((p) => list.map((s) => p.rows[s.id]).filter(Boolean));
      const part = rs.some((r) => r.partial) ? '≥' : '';
      const tr = el('tr'), td0 = el('td'); td0.appendChild(label); tr.appendChild(td0);
      for (const v of [nf.format(ps.length), part + plainShort(rs.reduce((a, r) => a + r.bullets, 0)), part + short(rs.reduce((a, r) => a + r.buyins, 0)), short(rs.reduce((a, r) => a + r.prizes, 0))]) tr.appendChild(el('td', '', v));
      return tr;
    }, renderPlayers);
    t.appendChild(tb); const wrap = el('div', 'tscroll'); wrap.appendChild(t); g.appendChild(wrap); box.appendChild(g);
    const scopeTxt = [prefs.year, prefs.finished ? 'Finished events' : '', prefs.country ? `${flag(prefs.country)} ${regionName(prefs.country)}` : '', q ? `“${q}”` : ''].filter(Boolean).join(' · ');
    const h = $('#summary-h');
    h.className = 'note' + (!prefs.known && partial ? ' warn' : '');
    h.textContent = (scopeTxt ? scopeTxt + ' · ' : '') + (prefs.known ? 'Events where every bullet is credited to a player' : partial ? '≥ Some events have bullets no player is credited with (see each series): counts there are a minimum' : 'All events');
  }
  // A by-series table's rows: one per organiser; an organiser with several series has a button that opens one row each.
  // label(s, under): a single series' first cell (under: listed beneath its organiser, so without its name); row(series list, first cell) builds a row; redraw re-renders after a toggle
  const openOrgs = new Set();
  function fillGrouped(tb, srcs, label, row, redraw) {
    for (const o of ORGS) {
      const mine = srcs.filter((s) => s.org === o); if (!mine.length) continue;
      if (mine.length === 1) { tb.appendChild(row(mine, label(mine[0]))); continue; }
      const open = openOrgs.has(o);
      const b = el('button', 'grp'); b.type = 'button'; b.setAttribute('aria-expanded', String(open));
      b.title = open ? 'Hide each series' : 'Show each series';
      b.appendChild(stag(mine[0].id, '×' + mine.length)); b.append(open ? ' ▾' : ' ▸');
      b.addEventListener('click', () => { if (open) openOrgs.delete(o); else openOrgs.add(o); redraw(); });
      tb.appendChild(row(mine, b));
      if (open) for (const s of mine) { const tr = row([s], label(s, true)); tr.className = 'sub'; tb.appendChild(tr); }
    }
  }

  function renderPlayers() {
    const all = getModel();
    $('#n-players').textContent = all.length ? nf.format(all.length) : '';
    const q = $('#players-q').value.trim().toLowerCase(), qk = norm(q);
    fillCountries($('#players-country'), all.map((p) => p.cc));
    let rows = q ? all.filter((p) => p.names.some((n) => n.toLowerCase().includes(q)) || (qk && p.keys.some((k) => k.includes(qk)))) : all;
    if (prefs.country) rows = rows.filter((p) => p.cc === prefs.country);
    const k = prefs.sort, dir = prefs.sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort(k === 'name' ? (a, b) => a.name.localeCompare(b.name) * -dir : (a, b) => ((a[k] - b[k]) * dir) || (b.prizes - a.prizes) || a.name.localeCompare(b.name));
    $('#players-count').textContent = plural(rows.length, 'player', 'players');
    $('#players-dir').textContent = dir < 0 ? '↓' : '↑';
    renderSummary(rows, q);
    const ul = $('#players'); ul.replaceChildren();
    if (!rows.length) ul.appendChild(el('li', 'empty', all.length ? 'No players match.' : views ? 'No players in these events.' : 'Loading players…'));
    for (const p of rows.slice(0, playersLimit)) {
      const li = el('li'), b = el('button', 'row'); b.type = 'button';
      const left = el('div');
      left.appendChild(el('div', 'nm', withFlag(p.cc, p.name)));
      const meta = el('div', 'meta');
      meta.appendChild(seriesTags(p));
      meta.appendChild(el('span', '', `${p.partial ? '≥' : ''}${plural(p.bullets, 'bullet', 'bullets')} · ${plural(p.events, 'event', 'events')}`));
      meta.appendChild(el('span', '', p.cashes ? `${plural(p.cashes, 'cash', 'cashes')} · ${p.partial ? '≤' : ''}${Math.round(p.itm * 100)}% ITM` : 'no cash'));
      if (p.seated) meta.appendChild(el('span', 'tag seat', 'Playing now'));
      left.appendChild(meta);
      const right = el('div', 'num');
      right.appendChild(el('div', 'big', p.prizes ? short(p.prizes) : '—'));
      right.appendChild(el('div', 'small ' + (p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''), signed(p.net)));
      right.appendChild(el('div', 'small', 'in ' + (p.partial ? '≥' : '') + short(p.buyins)));
      b.append(left, right);
      const ref = refOf(p);
      b.addEventListener('click', () => openPerson(ref));
      li.appendChild(b); ul.appendChild(li);
    }
    $('#players-more').hidden = rows.length <= playersLimit;
  }
  $('#players-q').addEventListener('input', () => { playersLimit = 60; renderPlayers(); });
  $('#players-country').addEventListener('change', (e) => { prefs.country = e.target.value; savePrefs(); playersLimit = 60; renderPlayers(); });
  $('#players-sort').addEventListener('change', (e) => { prefs.sort = e.target.value; prefs.sortDir = e.target.value === 'name' ? 'asc' : 'desc'; savePrefs(); renderPlayers(); });
  $('#players-dir').addEventListener('click', () => { prefs.sortDir = prefs.sortDir === 'asc' ? 'desc' : 'asc'; savePrefs(); renderPlayers(); });
  $('#players-more').addEventListener('click', () => { playersLimit += 200; renderPlayers(); });

  /* ---------- events tab ---------- */
  // Links into a series' own tracker, which opens that event or player (?event=, ?player=)
  const linkTo = (key, k, v) => { const pg = SRC_BY[key].page; return withRepo(pg + (pg.includes('?') ? '&' : '?') + k + '=' + encodeURIComponent(v)); };
  const evHref = (e) => linkTo(e.src, 'event', e.kid);
  const playerHref = (key, name) => linkTo(key, 'player', name);
  const evTitle = (e) => `${e.label} ${e.name}`;
  function eventRow(e, right, sub) {
    const li = el('li'), a = el('a'); a.href = evHref(e);
    a.appendChild(el('div', 'when', e.start ? fDate.format(new Date(e.start * 1000)) : ''));
    const mid = el('div');
    const nm = el('div', 'nm'); nm.appendChild(stag(e.src, e.fest)); nm.append(' ' + evTitle(e)); mid.appendChild(nm);
    if (sub) mid.appendChild(sub);
    a.appendChild(mid); a.appendChild(right); li.appendChild(a);
    return li;
  }
  function renderEvents() {
    const q = $('#events-q').value.trim().toLowerCase();
    let rows = [];
    for (const s of SRC) if (prefs.on[s.org] && evIdx[s.id]) for (const e of evIdx[s.id].values()) rows.push(e);
    if (prefs.year) rows = rows.filter((e) => e.year === prefs.year);
    if (prefs.finished) rows = rows.filter((e) => e.finished);
    if (prefs.known) rows = rows.filter((e) => e.known);
    $('#n-events').textContent = rows.length ? nf.format(rows.length) : '';
    if (q) rows = rows.filter((e) => (evTitle(e) + ' ' + SRC_BY[e.src].name + ' ' + e.fest + ' ' + (e.winner ? e.winner.name : '')).toLowerCase().includes(q));
    const k = prefs.evSort;
    const val = (e) => (k === 'buyin' ? e.buyin : k === 'entries' ? e.entries : k === 'pool' ? e.pool : e.start);
    rows.sort((a, b) => val(b) - val(a) || b.start - a.start);
    $('#events-count').textContent = plural(rows.length, 'event', 'events');
    const box = $('#events-summary'); box.replaceChildren();
    if (rows.length) {
      const entries = rows.reduce((a, e) => a + e.entries, 0), pool = rows.reduce((a, e) => a + e.pool, 0);
      const big = rows.reduce((a, e) => (e.entries > a.entries ? e : a), rows[0]), rich = rows.reduce((a, e) => (e.pool > a.pool ? e : a), rows[0]);
      groupBox(box, [['Events', [['Events', nf.format(rows.length), plural(rows.filter((e) => e.known).length, 'with every bullet known', 'with every bullet known')],
        ['Entries', nf.format(entries), nf.format(Math.round(entries / rows.length)) + ' per event'], ['Prize pools', short(pool), '', 'gold'],
        ['Biggest field', nf.format(big.entries), evTitle(big)], ['Biggest pool', short(rich.pool), evTitle(rich)], ['Buy-ins', short(rows.reduce((a, e) => a + e.buyin * e.entries, 0)), 'entries × buy-in']]]]);
    }
    const ul = $('#events'); ul.replaceChildren();
    if (!rows.length) ul.appendChild(el('li', 'empty', views ? 'No events match.' : 'Loading events…'));
    for (const e of rows.slice(0, eventsLimit)) {
      const sub = el('div', 'sub');
      sub.append(`${nf.format(e.entries)} entries · ${short(e.buyin)}`);
      if (e.winner) { sub.append(' · won by '); sub.appendChild(el('b', '', withFlag(e.winner.cc, e.winner.name))); }
      else if (!e.finished) { sub.append(' · '); sub.appendChild(el('b', 'bag', 'running')); }
      const right = el('div', 'right'); right.appendChild(el('b', '', e.pool ? short(e.pool) : '—')); right.append(e.winner ? short(e.winner.prize) + ' first' : e.pool ? 'pool' : '');
      ul.appendChild(eventRow(e, right, sub));
    }
    $('#events-more').hidden = rows.length <= eventsLimit;
  }
  $('#events-q').addEventListener('input', () => { eventsLimit = 100; renderEvents(); });
  $('#events-sort').addEventListener('change', (e) => { prefs.evSort = e.target.value; savePrefs(); renderEvents(); });
  $('#events-more').addEventListener('click', () => { eventsLimit += 200; renderEvents(); });

  /* ---------- player panel ---------- */
  let openRef = null; // { src, name }: the player's name in one series, so the panel survives a filter change
  const refOf = (p) => { const s = SRC.find((x) => p.rows[x.id]); return { src: s.id, name: p.rows[s.id].name, key: p.key, cc: p.cc }; };
  const findPerson = (ref) => getModel().find((p) => p.rows[ref.src] && p.rows[ref.src].name === ref.name) ||
    getModel().find((p) => p.key === ref.key && (!p.cc || !ref.cc || p.cc === ref.cc));
  function personEvents(p) {
    const out = [];
    for (const s of SRC) {
      const r = p.rows[s.id]; if (!r) continue;
      for (const d of r.ev) { const e = (evIdx[s.id] || new Map()).get(String(d.num)); if (e) out.push({ ...d, e, net: d.prize - d.buyin }); }
    }
    return out.sort((a, b) => (a.e.start || 0) - (b.e.start || 0));
  }
  function openPerson(ref) {
    openRef = ref; syncToggles();
    const p = findPerson(ref);
    $('#sheet-name').textContent = withFlag((p && p.cc) || ref.cc, p ? p.name : ref.name);
    const sub = [];
    if (p && p.cc) sub.push(regionName(p.cc));
    if (p) sub.push('played ' + SRC.filter((s) => p.rows[s.id]).map((s) => (s.all ? `Triton (${plural(p.fests, 'festival', 'festivals')})` : s.name)).join(', '));
    if (p && p.names.length > 1) sub.push('also listed as ' + p.names.filter((n) => n !== p.name).join(', '));
    $('#sheet-sub').textContent = sub.join(' · ');
    const stats = $('#sheet-stats'); stats.replaceChildren();
    const items = p ? personEvents(p) : [];
    $('#sheet-hint').textContent = !p ? 'No events of this player match these filters.' : p.partial ? '≥ Some of these events have bullets no player is credited with: counts there are a minimum.' : '';
    if (p) {
      const best = items.filter((d) => d.pos).sort((a, b) => a.pos - b.pos || b.prize - a.prize)[0];
      const top = items.reduce((a, d) => (d.prize > (a ? a.prize : 0) ? d : a), null);
      const pre = p.partial ? '≥' : '';
      groupBox(stats, [
        ['Money', [['Buy-in', pre + short(p.buyins), p.bullets ? short(p.buyins / p.bullets) + ' per bullet' : ''], ['Prizes', short(p.prizes), p.cashes ? short(p.prizes / p.cashes) + ' per cash' : '', 'gold'],
          ['Net', signed(p.net), p.buyins ? 'ROI ' + pct(p.net, p.buyins) : '', p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '']]],
        ['Field', [['Events', nf.format(p.events), plural(p.series, 'series', 'series')], ['Bullets', pre + nf.format(p.bullets), p.events ? (p.bullets / p.events).toFixed(2) + ' per event' : ''],
          ['Re-entries', pre + nf.format(Math.max(0, p.bullets - p.events)), pct(p.bullets - p.events, p.events)]]],
        ['Results', [['Cashes', nf.format(p.cashes), p.wins ? plural(p.wins, 'win', 'wins') : ''], ['ITM', (p.partial ? '≤' : '') + pct(p.cashedEvents, p.bullets), `${nf.format(p.cashedEvents)}/${nf.format(p.bullets)} bullets`],
          ['Best finish', best ? ord(best.pos) : '—', best ? evTitle(best.e) : ''], ['Biggest cash', top ? short(top.prize) : '—', top ? evTitle(top.e) : '', top ? 'gold' : '']]],
      ]);
    }
    // By series, each linking to the player in that series' tracker
    const t = $('#sheet-series'); t.replaceChildren();
    $('#sheet-series-wrap').hidden = !p;
    if (p) {
      t.innerHTML = '<thead><tr><th>Series</th><th>Events</th><th>Bullets</th><th>ITM</th><th>Net</th></tr></thead>';
      const tb = el('tbody');
      const link = (s, under) => {
        const r = p.rows[s.id], a = el('a', 'slink'); a.href = playerHref(s.id, r.name); a.title = `${r.name} in the ${s.name} tracker`;
        a.appendChild(under ? Object.assign(el('span', 'stag ' + s.org, s.tag || s.name), { title: s.name }) : stag(s.id, s.all ? (p.fests > 1 ? '×' + p.fests : '') : null)); a.append(' →'); return a;
      };
      fillGrouped(tb, SRC.filter((s) => p.rows[s.id]), link, (list, label) => {
        const rs = list.map((s) => p.rows[s.id]), part = rs.some((r) => r.partial);
        const sum = (f) => rs.reduce((a, r) => a + (r[f] || 0), 0), bullets = sum('bullets'), net = sum('net');
        const tr = el('tr'), td0 = el('td'); td0.appendChild(label); tr.appendChild(td0);
        tr.appendChild(el('td', '', nf.format(sum('events'))));
        tr.appendChild(el('td', '', (part ? '≥' : '') + nf.format(bullets)));
        tr.appendChild(el('td', '', (part ? '≤' : '') + (bullets ? Math.round(sum('cashedEvents') / bullets * 100) : 0) + '%'));
        tr.appendChild(el('td', net > 0 ? 'pos' : net < 0 ? 'neg' : '', signed(net)));
        return tr;
      }, () => openPerson(openRef));
      t.appendChild(tb);
    }
    // Every event, newest first
    const ul = $('#sheet-events'); ul.replaceChildren();
    if (!items.length) ul.appendChild(el('li', 'empty', 'No events.'));
    for (const d of items.slice().reverse()) {
      const sub = el('div', 'sub');
      sub.append(`${plural(d.b, 'bullet', 'bullets')} · ${short(d.buyin)}`);
      if (!d.e.finished) { sub.append(' · '); sub.appendChild(el('b', 'bag', 'running')); }
      const right = el('div', 'right');
      if (d.pos) { right.appendChild(el('b', 'gold', ord(d.pos))); right.append(short(d.prize)); }
      else { right.appendChild(el('b', 'neg', '−' + short(d.buyin))); right.append(d.e.finished ? 'no cash' : ''); }
      ul.appendChild(eventRow(d.e, right, sub));
    }
    const wasHidden = $('#sheet').hidden;
    $('#sheet').hidden = false; $('#sheet-bg').hidden = false;
    $('#sheet-chart-wrap').hidden = items.length < 2;
    if (items.length >= 2) drawBankroll($('#sheet-chart'), items);
    if (wasHidden) $('#sheet-close').focus();
  }
  function closeSheet() { openRef = null; $('#sheet').hidden = true; $('#sheet-bg').hidden = true; }
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-bg').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden && $('#menu').hidden) closeSheet(); });

  // Monotone cubic through the points (like d3.curveMonotoneX)
  function smoothPath(p) {
    if (p.length < 2) return '';
    const n = p.length, d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / ((p[i + 1][0] - p[i][0]) || 1));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
      const h0 = p[i][0] - p[i - 1][0], h1 = p[i + 1][0] - p[i][0], s = (d[i - 1] * h1 + d[i] * h0) / (h0 + h1);
      m[i] = (Math.sign(d[i - 1]) + Math.sign(d[i])) * Math.min(Math.abs(d[i - 1]), Math.abs(d[i]), 0.5 * Math.abs(s));
    }
    let out = `M${p[0][0]},${p[0][1]}`;
    for (let i = 0; i < n - 1; i++) { const h = (p[i + 1][0] - p[i][0]) / 3; out += `C${p[i][0] + h},${p[i][1] + m[i] * h} ${p[i + 1][0] - h},${p[i + 1][1] - m[i + 1] * h} ${p[i + 1][0]},${p[i + 1][1]}`; }
    return out;
  }
  // Running net after each event, in date order (prizes minus buy-ins)
  function drawBankroll(box, items) {
    box.replaceChildren();
    const pts = [{ i: 0, bank: 0, d: null }]; let bank = 0;
    items.forEach((d, k) => { bank += d.net; pts.push({ i: k + 1, bank, d }); });
    const NS = 'http://www.w3.org/2000/svg', W = Math.max(260, box.clientWidth || 360), H = 170;
    const lo = Math.min(0, ...pts.map((p) => p.bank)), hi = Math.max(0, ...pts.map((p) => p.bank)), span = hi - lo || 1;
    const mag = Math.pow(10, Math.floor(Math.log10(span / 3)));
    const step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((x) => span / x <= 4) || mag * 10;
    const y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
    const ticks = []; for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(v);
    const m = { l: Math.max(...ticks.map((v) => plainShort(v).length)) * 6.6 + 8, r: 52, t: 10, b: 22 }, n = pts.length - 1;
    const x = (i) => m.l + (W - m.l - m.r) * (i / n), y = (v) => m.t + (H - m.t - m.b) * (1 - (v - y0) / (y1 - y0 || 1));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Net over ${n} events, now ${bank >= 0 ? 'up' : 'down'} ${money(Math.abs(bank))}`);
    const add = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
    for (const v of ticks) { add('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : 'grid' }); add('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'lbl' }, plainShort(v)); }
    // Year labels along the bottom (month labels for a span inside one year)
    const lab = (d) => { const t = new Date(d.e.start * 1000); return yearsSpan > 1 ? String(t.getFullYear()) : t.toLocaleDateString('en-GB', { month: 'short' }); };
    const yearsSpan = new Set(items.map((d) => yearOf(d.e.start))).size;
    let prev = '', lastX = -99;
    pts.slice(1).forEach((p) => {
      if (!p.d.e.start) return; const s = lab(p.d); if (s === prev) return; prev = s;
      const xx = x(p.i), w = s.length * 6.2, left = Math.min(Math.max(m.l, xx - w / 2), W - m.r - w);
      if (left > lastX + 8) { add('text', { x: left, y: H - 6, class: 'lbl' }, s); lastX = left + w; }
    });
    const xy = pts.map((p) => [x(p.i), y(p.bank)]), dPath = smoothPath(xy), z = y(0);
    const uid = 'bk' + Math.random().toString(36).slice(2, 8), defs = add('defs', {});
    const cv = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
    const grad = (id, color, from, to) => {
      const g = document.createElementNS(NS, 'linearGradient'); g.setAttribute('id', id); g.setAttribute('gradientUnits', 'userSpaceOnUse');
      g.setAttribute('x1', 0); g.setAttribute('x2', 0); g.setAttribute('y1', from); g.setAttribute('y2', to);
      [[0, 0.35], [1, 0.02]].forEach(([o, a]) => { const st = document.createElementNS(NS, 'stop'); st.setAttribute('offset', o); st.setAttribute('stop-color', color); st.setAttribute('stop-opacity', a); g.appendChild(st); });
      defs.appendChild(g);
    };
    const clip = (id, yc, h) => { const c = document.createElementNS(NS, 'clipPath'); c.setAttribute('id', id); const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', 0); r.setAttribute('width', W); r.setAttribute('y', yc); r.setAttribute('height', Math.max(0, h)); c.appendChild(r); defs.appendChild(c); };
    grad(uid + 'gu', cv('--teal2'), m.t, z); grad(uid + 'gd', cv('--rose'), H - m.b, z); clip(uid + 'cu', 0, z); clip(uid + 'cd', z, H - z);
    const area = dPath + `L${xy[xy.length - 1][0]},${z}L${xy[0][0]},${z}Z`;
    add('path', { d: area, fill: `url(#${uid}gu)`, 'clip-path': `url(#${uid}cu)` }); add('path', { d: area, fill: `url(#${uid}gd)`, 'clip-path': `url(#${uid}cd)` });
    add('path', { d: dPath, class: 'ln up', 'clip-path': `url(#${uid}cu)` }); add('path', { d: dPath, class: 'ln down', 'clip-path': `url(#${uid}cd)` });
    if (n <= 120) for (const p of pts.slice(1)) add('circle', { cx: x(p.i), cy: y(p.bank), r: p.d.prize > 0 ? 3.5 : 2.25, class: p.d.prize > 0 ? 'pt-out' : 'pt-in' });
    const endTxt = add('text', { x: x(n) + 6, y: y(bank) + 4, class: 'end' }, (bank > 0 ? '+' : bank < 0 ? '−' : '') + short(Math.abs(bank)));
    endTxt.style.fill = bank > 0 ? 'var(--teal2)' : bank < 0 ? 'var(--rose)' : 'var(--fg)';
    const hl = add('circle', { r: 6, fill: 'none', stroke: 'var(--fg)', 'stroke-width': 1.5, opacity: 0 });
    box.appendChild(svg);
    const tip = el('div', 'tip'); tip.hidden = true; box.appendChild(tip);
    const show = (ev) => {
      const r = svg.getBoundingClientRect(), k = W / r.width, mx = (ev.clientX - r.left) * k;
      const p = pts[Math.max(1, Math.min(n, Math.round((mx - m.l) / ((W - m.l - m.r) / n))))];
      hl.setAttribute('cx', x(p.i)); hl.setAttribute('cy', y(p.bank)); hl.setAttribute('opacity', 1);
      tip.replaceChildren(el('div', 'm', (p.d.e.start ? fDay.format(new Date(p.d.e.start * 1000)) + ' · ' : '') + SRC_BY[p.d.e.src].short + (p.d.e.fest ? ' ' + p.d.e.fest : '')), el('div', '', evTitle(p.d.e)),
        el('div', 'm', (p.d.pos ? ord(p.d.pos) + ' · ' : '') + signed(p.d.net) + ' → ' + signed(p.bank)));
      tip.hidden = false;
      const px = x(p.i) / k + 6, py = y(p.bank) / k + 10;
      tip.style.left = Math.max(0, Math.min(box.clientWidth - tip.offsetWidth, px - tip.offsetWidth / 2)) + 'px';
      tip.style.top = Math.max(0, py - tip.offsetHeight - 12) + 'px';
    };
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') { tip.hidden = true; hl.setAttribute('opacity', 0); } });
  }

  /* ---------- status, tabs, render ---------- */
  function setStatus() {
    const parts = [];
    const errs = Object.entries(errors);
    if (!REPO) parts.push('Saved series need ?repo=owner/name here');
    if (loading && !views) parts.push('Loading…');
    else if (fxBusy) parts.push('Loading exchange rates…');
    const at = Math.max(0, ...SRC.filter((s) => prefs.on[s.org] && Series.byId(s.id) && Series.status(s.entry) === 'live').map((s) => savedAt[s.id] || 0),
      ...Series.ofOrg('triton').filter((x) => Series.status(x) === 'live' && tritonLive[x.id]).map((x) => tritonLive[x.id].updatedAt || 0));
    const nSeries = SRC.filter((s) => !s.all).length + (tritonAll ? (tritonAll.index || []).length : 0) + Object.keys(tritonLive).length;
    if (views) parts.push(plural(nSeries, 'series', 'series'));
    if (at) parts.push('live data saved ' + ago(at));
    if (fxShown) parts.push(`in ${fxShown} at each date's rate`);
    for (const [id, e] of errs) parts.push(`${SRC_BY[id].name}: ${e}`);
    $('#dot').className = 'dot' + (errs.length ? ' err' : '');
    $('#status-text').textContent = parts.join(' · ') || 'Loading…';
  }
  setInterval(setStatus, 15000);
  function selectTab(tab) {
    prefs.tab = tab; savePrefs();
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('#view-players').hidden = tab !== 'players'; $('#view-events').hidden = tab !== 'events';
    render();
  }
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  function render() {
    if (prefs.tab === 'events') renderEvents(); else renderPlayers();
    if (prefs.tab === 'events' && views) $('#n-players').textContent = nf.format(getModel().length);
    if (prefs.tab !== 'events') { let n = 0; for (const s of SRC) if (prefs.on[s.org] && evIdx[s.id]) for (const e of evIdx[s.id].values()) if ((!prefs.year || e.year === prefs.year) && (!prefs.finished || e.finished) && (!prefs.known || e.known)) n++; $('#n-events').textContent = n ? nf.format(n) : ''; }
    if (openRef) openPerson(openRef);
    setStatus();
  }

  /* ---------- settings menu ---------- */
  const menuBtn = $('#menu-btn'), menu = $('#menu');
  const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); } });
  $('#refresh').addEventListener('click', () => { setMenu(false); loadAll(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadAll(); });

  /* ---------- boot ---------- */
  Series.fillNav($('nav.others'), null, '../');
  fillFx(); fillSrcChips(); syncToggles();
  $('#players-sort').value = prefs.sort; $('#events-sort').value = prefs.evSort;
  selectTab(prefs.tab === 'events' ? 'events' : 'players');
  loadAll();
  setInterval(loadAll, 5 * 60 * 1000);
})();
