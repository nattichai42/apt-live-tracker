/*
 * Every series the site tracks, in one place: the home page, each tracker page, the all-series page and the
 * GitHub poller all read this list.
 *
 * Adding a series of an organiser already supported (another APT stop, the next GLPC, a Triton festival):
 *   1. Add an entry to LIST below (copy one of the same organiser and change it).
 *   2. Push. The "Poll series" workflow starts polling it on its start date (or run that workflow by hand with
 *      its id), saving to the entry's data branch, and the page is at <organiser page>?s=<id>.
 * A new organiser also needs an engine (docs/<org>/<org>.js with configure(), pollOnce(), players() and the rest of
 * the same interface) and a page in docs/<org>/: see README.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Series = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One engine and one page per organiser. prefs: browser storage key for the page's settings (shared by its series).
  // poll: the GitHub poller's pace (seconds between rounds at least, requests per second on average, minutes between
  // saves); a series can override it with its own poll: {...}.
  const ORGANISERS = {
    // APT seating is only seen by polling (busts and re-entries happen between looks), so it is polled hardest:
    // 3 requests/s is half of what the site took without refusing in a test; the poller backs off if it ever refuses
    apt: { name: 'APT', engine: 'apt/tracker.js', global: 'APTTracker', page: 'apt/', prefs: 'apt-live-prefs-v1',
      poll: { minInterval: 5, maxInterval: 30, budget: 3, publishEvery: 1 } },
    glpc: { name: 'GLPC', engine: 'glpc/glpc.js', global: 'GLPCTracker', page: 'glpc/', prefs: 'glpc-live-prefs-v1',
      poll: { minInterval: 10, maxInterval: 60, budget: 1, publishEvery: 3 } },
    triton: { name: 'Triton', engine: 'triton/triton.js', global: 'TritonTracker', page: 'triton/', prefs: 'triton-live-prefs-v1',
      poll: { minInterval: 15, maxInterval: 60, budget: 0.5, publishEvery: 2 } },
  };

  // id: never changes (links, browser storage). branch: where the poller saves (one per series).
  // start/end: first and last day in the venue's time zone (tz). place: the clock the page shows times in.
  // tag: short name next to the organiser ("APT Taipei '26"). source: what the engine needs to find the series.
  // Banner (home page): title, mark, sub, art (apt | glpc | triton | tone), watermark.
  // storage: browser key of the page's saved copy (defaults to the id).
  const LIST = [
    { id: 'apt-taipei-2026', org: 'apt', branch: 'data', storage: 'apt-live-state-v1',
      name: 'APT Taipei 2026', tag: "Taipei '26", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2026-11-12', end: '2026-11-29',
      link: 'https://www.theasianpokertour.com/series/apt-championship-taipei-2026',
      title: 'APT Championship, Taipei 2026', mark: 'APT Taipei', sub: 'Championship · 2026', art: 'apt', watermark: '2026',
      source: { series: 'apt-championship-taipei-2026' } },
    { id: 'apt-jeju-classic-2027', org: 'apt', branch: 'apt-jeju-classic-2027-data',
      name: 'APT Jeju Classic 2027', tag: "Jeju Classic '27", place: 'Jeju', tz: 'Asia/Seoul', currency: 'KRW', start: '2027-01-22', end: '2027-01-31',
      link: 'https://www.theasianpokertour.com/series/apt-jeju-classic-south-korea-2027',
      title: 'APT Jeju Classic, South Korea 2027', mark: 'APT Jeju Classic', sub: 'South Korea · 2027', art: 'apt', watermark: '2027',
      source: { series: 'apt-jeju-classic-south-korea-2027' } },
    { id: 'apt-taipei-2027', org: 'apt', branch: 'apt-taipei-2027-data',
      name: 'APT Taipei 2027', tag: "Taipei '27", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2027-04-21', end: '2027-05-03',
      link: 'https://www.theasianpokertour.com/series/apt-taipei-taiwan-2027',
      title: 'APT Taipei, Taiwan 2027', mark: 'APT Taipei', sub: 'Taiwan · 2027', art: 'apt', watermark: '2027',
      source: { series: 'apt-taipei-taiwan-2027' } },
    { id: 'apt-jeju-2027', org: 'apt', branch: 'apt-jeju-2027-data',
      name: 'APT Jeju 2027', tag: "Jeju '27", place: 'Jeju', tz: 'Asia/Seoul', currency: 'KRW', start: '2027-10-01', end: '2027-10-10',
      link: 'https://www.theasianpokertour.com/series/apt-jeju-south-korea-2027',
      title: 'APT Jeju, South Korea 2027', mark: 'APT Jeju', sub: 'South Korea · 2027', art: 'apt', watermark: '2027',
      source: { series: 'apt-jeju-south-korea-2027' } },
    { id: 'apt-championship-taipei-2027', org: 'apt', branch: 'apt-championship-taipei-2027-data',
      name: 'APT Championship Taipei 2027', tag: "Championship '27", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2027-11-12', end: '2027-11-28',
      link: 'https://www.theasianpokertour.com/series/apt-championship-taiwan-2027',
      title: 'APT Championship, Taipei 2027', mark: 'APT Championship', sub: 'Taipei · 2027', art: 'apt', watermark: '2027',
      source: { series: 'apt-championship-taiwan-2027' } },
    { id: 'triton-n-cyprus-2026', org: 'triton', branch: 'triton-data', storage: 'triton-live-state-v1',
      name: 'Triton N. Cyprus 2026', tag: "N. Cyprus '26", place: 'Cyprus', tz: 'Europe/Athens', currency: 'USD', start: '2026-11-15', end: '2026-11-30',
      link: 'https://tritonpoker.plus/festival/daca20f2-506a-4377-9c73-2651390b6782',
      title: 'Triton, Northern Cyprus 2026', mark: 'Triton', sub: 'Northern Cyprus · 2026', art: 'triton', watermark: 'TRITON',
      source: { festival: 'daca20f2-506a-4377-9c73-2651390b6782', series: 'triton-n-cyprus-2026' } },
    { id: 'glpc-vi', org: 'glpc', branch: 'glpc-data', storage: 'glpc-live-state-v1',
      name: 'GLPC VI', tag: 'VI', place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-11-18', end: '2026-11-29',
      link: 'https://grandloyal.vn/series/121',
      title: 'Grand Loyal Poker Championships VI', mark: 'GLPC VI', sub: 'Grand Loyal · Vietnam', art: 'glpc', watermark: 'VI',
      source: { series: 'glpc-vi', seriesUrl: 'https://grandloyal.vn/series/121', from: '2026-11-18', to: '2026-11-30' } },
  ];

  const today = (tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
  // 'live' between its first and last day (venue time), else 'soon' or 'past'
  const status = (s) => { const t = today(s.tz); return t < s.start ? 'soon' : t > s.end ? 'past' : 'live'; };
  const byId = (id) => LIST.find((s) => s.id === id) || null;
  const ofOrg = (org) => LIST.filter((s) => s.org === org);
  // The series a page shows: ?s=<id>, else the organiser's running one, else the next to start, else the latest
  function pick(org, id) {
    const own = ofOrg(org), want = id && own.find((s) => s.id === id);
    if (want) return want;
    const by = (st) => own.filter((s) => status(s) === st);
    return by('live').sort((a, b) => (a.start < b.start ? 1 : -1))[0] || by('soon').sort((a, b) => (a.start < b.start ? -1 : 1))[0] ||
      own.slice().sort((a, b) => (a.end < b.end ? 1 : -1))[0] || null;
  }
  // Link to a series' page from the site's root ('' for the root itself, '../' from a page one folder down)
  const pageUrl = (s, root) => `${root || ''}${ORGANISERS[s.org].page}${pick(s.org) === s ? '' : '?s=' + encodeURIComponent(s.id)}`;
  const storageKey = (s) => s.storage || s.id + '-state-v1';
  // Poll it now? From the day before it starts until two days after it ends (late results, final payouts)
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const pollable = (s) => { const t = today(s.tz); return t >= shift(s.start, -1) && t <= shift(s.end, 2); };

  const pollOpts = (s) => ({ ...ORGANISERS[s.org].poll, ...(s.poll || {}) });
  // A venue's time zone from a series' name or slug (for past series, which have no entry here)
  const TZ = [[/korea|jeju|incheon|seoul/i, 'Asia/Seoul'], [/taipei|taiwan/i, 'Asia/Taipei'], [/manila|philippines/i, 'Asia/Manila'],
    [/vietnam|hanoi|da[ -]?nang|phu[ -]?quoc|ho[ -]?chi[ -]?minh|saigon/i, 'Asia/Ho_Chi_Minh'], [/macau/i, 'Asia/Macau'], [/japan|tokyo|osaka/i, 'Asia/Tokyo'],
    [/cambodia|phnom penh/i, 'Asia/Phnom_Penh'], [/thailand|bangkok|pattaya/i, 'Asia/Bangkok'], [/cyprus/i, 'Asia/Nicosia']];
  const tzOf = (name, fallback) => (TZ.find(([re]) => re.test(name)) || [, fallback || 'UTC'])[1];
  // Over: two days past its last day, or every event it listed has finished
  function over(s, state) {
    const t = today(s.tz); if (t > shift(s.end, 2)) return true;
    const ev = Object.values((state && state.events) || {});
    return ev.length > 0 && ev.every((e) => e.phase === 'Completed' || e.closed);
  }

  // The footer links on each page: home, every player, and the other series running or coming up
  function fillNav(nav, current, root) {
    if (!nav || typeof document === 'undefined') return;
    const a = (href, text) => { const x = document.createElement('a'); x.href = href; x.textContent = text; return x; };
    const links = [a(root || './', 'Home'), a(`${root || ''}all/`, 'All series')];
    for (const s of LIST) if (s !== current && status(s) !== 'past') links.push(a(pageUrl(s, root), s.name));
    links.push(a(`${root || ''}triton/?view=all`, 'Triton all-time'));
    nav.replaceChildren();
    links.forEach((x, i) => { if (i) nav.append(' · '); nav.appendChild(x); });
  }
  // A tracker page's header: the series' banner name and a link to its page at the organiser
  function fillBrand(s) {
    if (typeof document === 'undefined') return;
    const h = document.querySelector('.brand h1 a'), sub = document.querySelector('.brand span');
    if (h) h.textContent = s.mark;
    if (sub) { const x = document.createElement('a'); x.href = s.link; x.target = '_blank'; x.rel = 'noopener'; x.textContent = s.sub; sub.replaceChildren(x); }
    document.title = `${s.name} Tracker`;
  }

  return { ORGANISERS, LIST, status, byId, ofOrg, pick, pageUrl, storageKey, pollable, pollOpts, over, fillNav, fillBrand, tzOf };
});
