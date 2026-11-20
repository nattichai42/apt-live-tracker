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
  // archive: where a finished series is saved for good (tool, folder, the list in its index.json, and the field of a
  // series' source that names its file). The poller runs the tool when a series it watched is over. Without one
  // (GLPC), a finished series stays on its data branch.
  const ORGANISERS = {
    // APT seating is only seen by polling (busts and re-entries happen between looks), so it is polled hardest:
    // 3 requests/s is half of what the site took without refusing in a test; the poller backs off if it ever refuses
    apt: { name: 'APT', engine: 'apt/tracker.js', global: 'APTTracker', page: 'apt/', prefs: 'apt-live-prefs-v1',
      poll: { minInterval: 5, maxInterval: 30, budget: 3, publishEvery: 1 },
      archive: { tool: 'tools/apt-archive.js', dir: 'apt/archive/', list: 'series', key: 'series' } },
    glpc: { name: 'GLPC', full: 'Grand Loyal Poker Championships', engine: 'glpc/glpc.js', global: 'GLPCTracker', page: 'glpc/', prefs: 'glpc-live-prefs-v1',
      poll: { minInterval: 10, maxInterval: 60, budget: 1, publishEvery: 3 },
      archive: { tool: 'tools/series-archive.js', dir: 'glpc/archive/', list: 'series', key: 'series', note: "players, counts and the top places' payouts from Grand Loyal (re-entries in the counts, not credited to players)" } },
    // USOP festivals run on Grand Loyal's tracker too: GLPC's engine and page (docs/usop/index.html is made from it)
    usop: { name: 'USOP', full: 'USOP', engine: 'glpc/glpc.js', global: 'GLPCTracker', page: 'usop/', prefs: 'usop-live-prefs-v1',
      poll: { minInterval: 10, maxInterval: 60, budget: 1, publishEvery: 3 },
      archive: { tool: 'tools/series-archive.js', dir: 'usop/archive/', list: 'series', key: 'series', note: "players, counts and the top places' payouts from Grand Loyal (re-entries in the counts, not credited to players)" } },
    // Gods of Poker: complete records on every event page (each bullet, bust and payout), so a poll reads the events
    // being played every half minute or so; its engine builds on the APT engine (load apt/tracker.js first)
    gop: { name: 'GOP', full: 'Gods of Poker', engine: 'gop/gop.js', needs: ['apt/tracker.js'], global: 'GOPTracker', page: 'gop/', prefs: 'gop-live-prefs-v1',
      poll: { minInterval: 30, maxInterval: 90, budget: 0.3, publishEvery: 2 },
      archive: { tool: 'tools/series-archive.js', dir: 'gop/archive/', list: 'series', key: 'series', note: "Gods of Poker's complete records: every bullet, bust and payout" } },
    // Royal Poker Tour (Vietnam): standings and payouts per event; re-entries and bust times only from watching live
    // (a new seat id is a re-entry). Its engine builds on the APT engine too
    rop: { name: 'RPT', full: 'Royal Poker Tour', engine: 'rop/rop.js', needs: ['apt/tracker.js'], global: 'ROPTracker', page: 'rop/', prefs: 'rop-live-prefs-v1',
      poll: { minInterval: 20, maxInterval: 60, budget: 1, publishEvery: 2 },
      archive: { tool: 'tools/series-archive.js', dir: 'rop/archive/', list: 'series', key: 'series', note: 'standings and payouts as published by the Royal Poker Tour (re-entries not credited to players)' } },
    triton: { name: 'Triton', engine: 'triton/triton.js', global: 'TritonTracker', page: 'triton/', prefs: 'triton-live-prefs-v1',
      poll: { minInterval: 15, maxInterval: 60, budget: 0.5, publishEvery: 2 },
      archive: { tool: 'tools/triton-archive.js', dir: 'triton/archive/', list: 'festivals', key: 'festival' } },
  };

  // id: never changes (links, browser storage). branch: where the poller saves (one per series).
  // start/end: first and last day in the venue's time zone (tz). place: the clock the page shows times in.
  // tag: short name next to the organiser ("APT Taipei '26"). source: what the engine needs to find the series.
  // Banner (home page): title, mark, sub, art (apt | gop | rop | glpc | usop | triton | tone), watermark.
  // storage: browser key of the page's saved copy (defaults to the id).
  // past: a series from before the site tracked it, known only from its archive (never polled; tools/series-archive.js).
  // source.smp: read from SoMuchPoker's event calendar instead of the organiser's tracker (tools/smp.js).
  // source.smpPayouts: the tracker's festival, with SoMuchPoker's payouts put in (its full places for the tracker's top few).
  const LIST = [
    { id: 'apt-taipei-2026', org: 'apt', branch: 'data', storage: 'apt-live-state-v1',
      name: 'APT Championship Taipei 2026', tag: "Championship '26", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2026-11-12', end: '2026-11-29',
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
    { id: 'gop-taipei-2027', org: 'gop', branch: 'gop-taipei-2027-data',
      name: 'GOP Taipei 2027', tag: "Taipei '27", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2027-02-12', end: '2027-02-22',
      link: 'https://godsofpoker.com/series/taipei-2027',
      title: 'Gods of Poker, Taipei 2027', mark: 'GOP Taipei', sub: 'Gods of Poker · 2027', art: 'gop', watermark: '2027',
      source: { series: 'taipei-2027' } },
    { id: 'rop-grand-final-2026', org: 'rop', branch: 'rop-grand-final-2026-data',
      name: 'RPT V Grand Final', tag: "Grand Final '26", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-11-30', end: '2026-12-11',
      link: 'https://royal-poker.com/en',
      title: 'Royal Poker Tour V, Grand Final 2026', mark: 'RPT Grand Final', sub: 'Royal Poker Tour · Vietnam', art: 'rop', watermark: 'V',
      source: { series: 'rpt-v-grand-final' } },
    { id: 'triton-n-cyprus-2026', org: 'triton', branch: 'triton-data', storage: 'triton-live-state-v1',
      name: 'Triton N. Cyprus 2026', tag: "N. Cyprus '26", place: 'Cyprus', tz: 'Europe/Athens', currency: 'USD', start: '2026-11-15', end: '2026-11-30',
      link: 'https://tritonpoker.plus/festival/daca20f2-506a-4377-9c73-2651390b6782',
      title: 'Triton, Northern Cyprus 2026', mark: 'Triton', sub: 'Northern Cyprus · 2026', art: 'triton', watermark: 'TRITON',
      source: { festival: 'daca20f2-506a-4377-9c73-2651390b6782', series: 'triton-n-cyprus-2026' } },
    { id: 'glpc-iii', org: 'glpc', branch: 'glpc-iii-data', past: true,
      name: 'GLPC III', tag: "III", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-01-02', end: '2026-01-12',
      link: 'https://grandloyal.vn/series',
      title: 'Grand Loyal Poker Championships III', mark: 'GLPC III', sub: 'Grand Loyal · Vietnam', art: 'glpc', watermark: 'III',
      source: { series: 'glpc-iii', seriesUrl: 'https://grandloyal.vn/series', from: '2026-01-02', to: '2026-01-13' } },
    { id: 'glpc-iv', org: 'glpc', branch: 'glpc-iv-data', past: true,
      name: 'GLPC IV', tag: "IV", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-04-17', end: '2026-04-27',
      link: 'https://grandloyal.vn/series',
      title: 'Grand Loyal Poker Championships IV', mark: 'GLPC IV', sub: 'Grand Loyal · Vietnam', art: 'glpc', watermark: 'IV',
      source: { series: 'glpc-iv', seriesUrl: 'https://grandloyal.vn/series', from: '2026-04-17', to: '2026-04-28' } },
    { id: 'glpc-v', org: 'glpc', branch: 'glpc-v-data', past: true,
      name: 'GLPC V', tag: "V", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-07-29', end: '2026-08-09',
      link: 'https://grandloyal.vn/series',
      title: 'Grand Loyal Poker Championships V', mark: 'GLPC V', sub: 'Grand Loyal · Vietnam', art: 'glpc', watermark: 'V',
      source: { series: 'glpc-v', seriesUrl: 'https://grandloyal.vn/series', from: '2026-07-29', to: '2026-08-10' } },
    { id: 'usop-taiwan-2023', org: 'usop', branch: 'usop-taiwan-2023-data', past: true,
      name: 'USOP Taiwan 2023', tag: "Taiwan '23", place: 'Taipei', tz: 'Asia/Taipei', currency: 'TWD', start: '2023-02-10', end: '2023-02-19',
      link: 'https://somuchpoker.com/events-calendar/usop/2023/u-series-of-poker-usop-poker2u-2023-taiwan-series',
      title: 'USOP Poker2U Taiwan Series 2023', mark: 'USOP Taiwan', sub: 'Poker2U · 2023', art: 'usop', watermark: '2023',
      source: { series: 'usop-taiwan-2023', smp: '/events-calendar/usop/2023/u-series-of-poker-usop-poker2u-2023-taiwan-series' } },
    { id: 'usop-vietnam-2023', org: 'usop', branch: 'usop-vietnam-2023-data', past: true,
      name: 'USOP Vietnam 2023', tag: "Vietnam '23", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2023-04-14', end: '2023-04-24',
      link: 'https://somuchpoker.com/events-calendar/usop/2023/u-series-of-poker-usop-vietnam-2023',
      title: 'USOP Vietnam 2023', mark: 'USOP Vietnam', sub: 'Vietnam · 2023', art: 'usop', watermark: '2023',
      source: { series: 'usop-vietnam-2023', smp: '/events-calendar/usop/2023/u-series-of-poker-usop-vietnam-2023' } },
    { id: 'usop-hanoi-2023', org: 'usop', branch: 'usop-hanoi-2023-data', past: true,
      name: 'USOP Hanoi 2023', tag: "Hanoi '23", place: 'Hanoi', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2023-09-01', end: '2023-09-11',
      link: 'https://somuchpoker.com/events-calendar/usop/2023/u-series-of-poker-usop-hanoi-vietnam-2023',
      title: 'USOP Hanoi 2023', mark: 'USOP Hanoi', sub: 'Vietnam · 2023', art: 'usop', watermark: '2023',
      source: { series: 'usop-hanoi-2023', smp: '/events-calendar/usop/2023/u-series-of-poker-usop-hanoi-vietnam-2023' } },
    { id: 'usop-da-nang-2023', org: 'usop', branch: 'usop-da-nang-2023-data', past: true,
      name: 'USOP Da Nang 2023', tag: "Da Nang '23", place: 'Da Nang', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2023-11-17', end: '2023-11-27',
      link: 'https://somuchpoker.com/events-calendar/usop/2023/u-series-of-poker-usop-da-nang-vietnam-2023',
      title: 'USOP Da Nang 2023', mark: 'USOP Da Nang', sub: 'Vietnam · 2023', art: 'usop', watermark: '2023',
      source: { series: 'usop-da-nang-2023', smp: '/events-calendar/usop/2023/u-series-of-poker-usop-da-nang-vietnam-2023' } },
    { id: 'usop-da-nang-2024', org: 'usop', branch: 'usop-da-nang-2024-data', past: true,
      name: 'USOP Da Nang 2024', tag: "Da Nang '24", place: 'Da Nang', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2024-03-19', end: '2024-04-01',
      link: 'https://somuchpoker.com/events-calendar/usop/2024/u-series-of-poker-usop-danang-part-i-vietnam-2024',
      title: 'USOP Da Nang Part I 2024', mark: 'USOP Da Nang', sub: 'Vietnam · 2024', art: 'usop', watermark: '2024',
      source: { series: 'usop-da-nang-2024', smp: '/events-calendar/usop/2024/u-series-of-poker-usop-danang-part-i-vietnam-2024' } },
    { id: 'usop-hai-phong-sep-2024', org: 'usop', branch: 'usop-hai-phong-sep-2024-data', past: true,
      name: 'USOP Hai Phong Sep 2024', tag: "Hai Phong '24", place: 'Hai Phong', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2024-09-11', end: '2024-09-23',
      link: 'https://somuchpoker.com/events-calendar/usop/2024/usop-hai-phong-vietnam-september-2024',
      title: 'USOP Hai Phong 2024 (September)', mark: 'USOP Hai Phong', sub: 'September · 2024', art: 'usop', watermark: '2024',
      source: { series: 'usop-hai-phong-sep-2024', smp: '/events-calendar/usop/2024/usop-hai-phong-vietnam-september-2024' } },
    { id: 'usop-hai-phong-2024', org: 'usop', branch: 'usop-hai-phong-2024-data', past: true,
      name: 'USOP Hai Phong Grand Finale 2024', tag: "Grand Finale '24", place: 'Hai Phong', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2024-11-29', end: '2024-12-11',
      link: 'https://somuchpoker.com/events-calendar/usop/2024/usop-hai-phong',
      title: 'USOP Hai Phong Grand Finale 2024', mark: 'USOP Grand Finale', sub: 'Hai Phong · 2024', art: 'usop', watermark: '2024',
      source: { series: 'usop-hai-phong-2024', smp: '/events-calendar/usop/2024/usop-hai-phong' } },
    { id: 'usop-osaka-2025', org: 'usop', branch: 'usop-osaka-2025-data', past: true,
      name: 'USOP Japan Osaka 2025', tag: "Osaka '25", place: 'Osaka', tz: 'Asia/Tokyo', currency: 'JPY', start: '2025-10-02', end: '2025-10-08',
      link: 'https://somuchpoker.com/events-calendar/usop/2025/usop-japan-2025-osaka',
      title: 'USOP Japan 2025 Osaka', mark: 'USOP Osaka', sub: 'Japan · 2025', art: 'usop', watermark: '2025',
      source: { series: 'usop-osaka-2025', smp: '/events-calendar/usop/2025/usop-japan-2025-osaka' } },
    { id: 'usop-hanoi-2025', org: 'usop', branch: 'usop-hanoi-2025-data', past: true,
      name: 'USOP Hanoi 2025', tag: "Hanoi '25", place: 'Hanoi', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2025-10-10', end: '2025-10-22',
      link: 'https://grandloyal.vn/series',
      title: 'USOP Hanoi 2025 (GLPC, powered by USOP)', mark: 'USOP Hanoi', sub: 'Grand Loyal · 2025', art: 'usop', watermark: '2025',
      source: { series: 'usop-hanoi-2025', seriesUrl: 'https://grandloyal.vn/series', from: '2025-10-10', to: '2025-10-23' } },
    { id: 'usop-vietnam-2026-may', org: 'usop', branch: 'usop-vietnam-2026-may-data', past: true,
      name: 'USOP Vietnam May 2026', tag: "May '26", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-05-19', end: '2026-06-01',
      link: 'https://grandloyal.vn/series',
      title: 'USOP Vietnam 2026 (May)', mark: 'USOP Vietnam', sub: 'May · 2026', art: 'usop', watermark: '2026',
      source: { series: 'usop-vietnam-2026-may', seriesUrl: 'https://grandloyal.vn/series', from: '2026-05-19', to: '2026-06-02', smpPayouts: '/events-calendar/usop/2026/usop-vietnam-halong-bay-2026' } },
    { id: 'usop-vietnam-2026-aug', org: 'usop', branch: 'usop-vietnam-2026-aug-data', past: true,
      name: 'USOP Vietnam Aug 2026', tag: "Aug '26", place: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', currency: 'VND', start: '2026-08-27', end: '2026-09-09',
      link: 'https://grandloyal.vn/series',
      title: 'USOP Vietnam 2026 (August)', mark: 'USOP Vietnam', sub: 'August · 2026', art: 'usop', watermark: '2026',
      source: { series: 'usop-vietnam-2026-aug', seriesUrl: 'https://grandloyal.vn/series', from: '2026-08-27', to: '2026-09-10', smpPayouts: '/events-calendar/usop/2026/usop-vietnam-series-2026' } },
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
  const pageUrl = (s, root) => `${root || ''}${ORGANISERS[s.org].page}${s.past ? '?f=' + encodeURIComponent(s.source.series) : pick(s.org) === s ? '' : '?s=' + encodeURIComponent(s.id)}`;
  const storageKey = (s) => s.storage || s.id + '-state-v1';
  // Poll it now? From the day before it starts until two days after it ends (late results, final payouts)
  const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const pollable = (s) => { if (s.past) return false; const t = today(s.tz); return t >= shift(s.start, -1) && t <= shift(s.end, 2); };

  const pollOpts = (s) => ({ ...ORGANISERS[s.org].poll, ...(s.poll || {}) });
  // A venue's time zone from a series' name or slug (for past series, which have no entry here)
  const TZ = [[/korea|jeju|incheon|seoul/i, 'Asia/Seoul'], [/taipei|taiwan/i, 'Asia/Taipei'], [/manila|philippines/i, 'Asia/Manila'],
    [/vietnam|hanoi|da[ -]?nang|phu[ -]?quoc|ho[ -]?chi[ -]?minh|saigon/i, 'Asia/Ho_Chi_Minh'], [/macau/i, 'Asia/Macau'], [/japan|tokyo|osaka/i, 'Asia/Tokyo'],
    [/cambodia|phnom penh/i, 'Asia/Phnom_Penh'], [/thailand|bangkok|pattaya/i, 'Asia/Bangkok'], [/cyprus/i, 'Asia/Nicosia']];
  const tzOf = (name, fallback) => (TZ.find(([re]) => re.test(name)) || [, fallback || 'UTC'])[1];
  // Over: two days past its last day, or its last day has come and every event it listed has finished
  function over(s, state) {
    const t = today(s.tz); if (t > shift(s.end, 2)) return true;
    if (t < s.end) return false;
    const ev = Object.values((state && state.events) || {});
    return ev.length > 0 && ev.every((e) => e.phase === 'Completed' || e.closed);
  }
  // The id of a series' file in its organiser's archive (null when the organiser has none)
  const archiveId = (s) => { const a = ORGANISERS[s.org].archive; return a ? s.source[a.key] : null; };

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

  return { ORGANISERS, LIST, status, byId, ofOrg, pick, pageUrl, storageKey, pollable, pollOpts, over, archiveId, fillNav, fillBrand, tzOf };
});
