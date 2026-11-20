// Offline checks of the series list, the saved archives and the engines' packing. No dependencies, no network:
//   node --test tests/data.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DOCS, f), 'utf8'));
const Series = require('../docs/series.js');
const A = require('../docs/apt/tracker.js');
const T = require('../docs/triton/triton.js');
const { FX } = require('../docs/fx.js');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('series list: every entry is complete and nothing is shared between two series', () => {
  const need = ['id', 'org', 'branch', 'name', 'tag', 'place', 'tz', 'currency', 'start', 'end', 'link', 'title', 'mark', 'sub', 'art', 'source'];
  const seen = { id: new Set(), branch: new Set(), storage: new Set() };
  for (const s of Series.LIST) {
    for (const k of need) assert.ok(s[k], `${s.id || '?'}: no ${k}`);
    assert.ok(Series.ORGANISERS[s.org], `${s.id}: unknown organiser ${s.org}`);
    assert.match(s.start, /^\d{4}-\d\d-\d\d$/, `${s.id}: start`);
    assert.match(s.end, /^\d{4}-\d\d-\d\d$/, `${s.id}: end`);
    assert.ok(s.start <= s.end, `${s.id}: ends before it starts`);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: s.tz }), `${s.id}: time zone ${s.tz}`);
    assert.ok(FX.LIST.includes(s.currency), `${s.id}: currency ${s.currency} isn't one the currency switch knows`);
    for (const [k, v] of [['id', s.id], ['branch', s.branch], ['storage', Series.storageKey(s)]]) {
      assert.ok(!seen[k].has(v), `${s.id}: ${k} "${v}" already used`); seen[k].add(v);
    }
    assert.notEqual(s.branch, 'main', `${s.id}: polls onto main`);
    const a = Series.ORGANISERS[s.org].archive;
    if (a) assert.ok(s.source[a.key], `${s.id}: source.${a.key} names its archive file`);
    // the engine accepts its source
    const eng = require(path.join(DOCS, Series.ORGANISERS[s.org].engine));
    assert.equal(typeof eng.configure(s.source).pollOnce, 'function');
  }
  for (const o of Object.values(Series.ORGANISERS)) {
    assert.ok(fs.existsSync(path.join(DOCS, o.engine)), `engine ${o.engine}`);
    assert.ok(fs.existsSync(path.join(DOCS, o.page, 'index.html')), `page ${o.page}`);
    if (o.archive) assert.ok(fs.existsSync(path.join(ROOT, o.archive.tool)), `archive tool ${o.archive.tool}`);
  }
});

test('series list: polled from the day before it starts until two days after it ends', () => {
  const s = (start, end) => ({ id: 't', org: 'apt', tz: 'UTC', start, end });
  assert.equal(Series.pollable(s(day(2), day(5))), false);
  assert.equal(Series.pollable(s(day(1), day(5))), true);
  assert.equal(Series.pollable(s(day(-9), day(-2))), true);
  assert.equal(Series.pollable(s(day(-9), day(-3))), false);
  assert.equal(Series.status(s(day(-1), day(1))), 'live');
});

test('series list: over only from its last day, or two days after it', () => {
  const done = { events: { a: { phase: 'Completed' }, b: { closed: true } } };
  const open = { events: { a: { phase: 'Completed' }, b: { phase: 'Running' } } };
  const s = (start, end) => ({ id: 't', org: 'apt', tz: 'UTC', start, end });
  assert.equal(Series.over(s(day(-3), day(3)), done), false, 'every listed event done, but days left: not over');
  assert.equal(Series.over(s(day(-3), day(0)), done), true);
  assert.equal(Series.over(s(day(-3), day(0)), open), false);
  assert.equal(Series.over(s(day(-3), day(0)), { events: {} }), false, 'nothing listed yet');
  assert.equal(Series.over(s(day(-9), day(-3)), open), true, 'two days past its end');
});

test('ctl.js answers the workflow', () => {
  const ctl = (...a) => { try { return { out: execFileSync(process.execPath, [path.join(ROOT, 'poller/ctl.js'), ...a], { encoding: 'utf8', stdio: 'pipe' }), code: 0 }; } catch (e) { return { out: e.stdout, code: e.status }; } };
  const active = ctl('active').out.split('\n').filter(Boolean);
  for (const id of active) assert.ok(Series.byId(id), `active lists unknown ${id}`);
  assert.equal(ctl('branch', Series.LIST[0].id).out.trim(), Series.LIST[0].branch);
  assert.equal(ctl('branch', 'no-such-series').code, 2);
  const noArchive = Series.LIST.find((s) => !Series.ORGANISERS[s.org].archive);
  if (noArchive) assert.equal(ctl('archive', noArchive.id, 'x').code, 3);
});

test('APT archive: index and files agree, files are in the current packed form', () => {
  const ix = read('apt/archive/index.json');
  assert.ok(ix.series.length > 0);
  const files = fs.readdirSync(path.join(DOCS, 'apt/archive')).filter((f) => f.endsWith('.json') && !['index.json', 'fx.json'].includes(f));
  assert.deepEqual(files.map((f) => f.slice(0, -5)).sort(), ix.series.map((s) => s.id).sort(), 'a file per index entry');
  for (const f of ix.series) {
    for (const k of ['id', 'name', 'place', 'tag', 'start', 'end', 'tz', 'currency']) assert.ok(f[k], `${f.id}: no ${k}`);
    const raw = read(`apt/archive/${f.id}.json`);
    const st = A.unpack(JSON.parse(JSON.stringify(raw)));
    assert.ok(Object.keys(st.events).length > 0, `${f.id}: no events`);
    assert.deepEqual(A.pack(A.unpack(JSON.parse(JSON.stringify(raw)))), raw, `${f.id}: pack(unpack(file)) changes it (run apt-archive.js --repack)`);
    // Pages skip repair() for a file stamped with the current rules, so the file must already be what it would give
    assert.equal(raw.repaired, A.REPAIR, `${f.id}: saved under older repair rules (run apt-archive.js --repack)`);
    const c = JSON.parse(JSON.stringify(st)); delete c.repaired; A.repair(c);
    assert.deepEqual(c.events, st.events, `${f.id}: repair() would still change it (raise REPAIR in tracker.js, then apt-archive.js --repack)`);
    assert.deepEqual(c.aliases || {}, st.aliases || {}, `${f.id}: repair() would still add aliases (raise REPAIR, then --repack)`);
    assert.equal(A.players(st).length > 0, true, `${f.id}: no players`);
  }
});

test('APT archive: every event can be shown in USD from fx.json alone', () => {
  FX.seed(read('apt/archive/fx.json'));
  const missing = new Set();
  for (const f of read('apt/archive/index.json').series) {
    const st = read(`apt/archive/${f.id}.json`);
    for (const e of Object.values(st.events)) {
      const cur = e.currency || f.currency;
      if (!FX.LIST.includes(cur)) { missing.add(`${f.id}: currency "${cur}"`); continue; }
      if (FX.factor(cur, 'USD', FX.ymd(e.start || st.updatedAt)) == null) missing.add(`${f.id}: ${cur} on ${FX.ymd(e.start || st.updatedAt)}`);
    }
  }
  assert.deepEqual([...missing].slice(0, 10), [], 'run apt-archive.js --rates');
});

test('Triton archive: all.json gives the same players and timelines as merging every festival file', () => {
  const ix = read('triton/archive/index.json').festivals;
  const all = read('triton/archive/all.json');
  assert.deepEqual((all.index || []).map((f) => f.id), ix.map((f) => f.id), 'all.json is behind index.json (run triton-archive.js --merge)');
  const a = T.mergeStates(ix.map((f) => ({ state: read(`triton/archive/${f.id}.json`), tag: f.tag, start: f.start })));
  const b = T.mergeStates([{ state: T.unpack(all) }]);
  for (const opts of [{}, { fromStart: true }, { finished: true }]) {
    const pa = T.players(a, opts), pb = T.players(b, opts);
    assert.equal(pb.length, pa.length, `players ${JSON.stringify(opts)}`);
    for (let i = 0; i < pa.length; i++) assert.deepEqual(pb[i], pa[i], `player ${i} ${JSON.stringify(opts)}`);
  }
  for (const p of T.players(a).slice(0, 25)) assert.deepEqual(T.playerTimeline(b, p.name), T.playerTimeline(a, p.name), p.name);
  // and every date it covers converts
  FX.seed(all.fx);
  for (const f of ix) if (f.currency && f.currency !== 'USD') assert.notEqual(FX.factor(f.currency, 'USD', f.start), null, `${f.tag}: ${f.currency}`);
});

test('APT: an event with its winner paid and nobody left counts as finished', () => {
  A.configure({ series: 'test' });
  const st = A.emptyState();
  st.events = {
    d1: { kid: 'd1', num: 7, name: 'Event #7 Main Event Day 1A', phase: 'Completed', start: 100, remaining: 0, p: {} },
    fd: { kid: 'fd', num: 7, name: 'Event #7 Main Event Final Day', phase: 'In The Money', start: 200, remaining: 0, p: { 'Ann Lee': { st: 's', b: 1 } } },
    x: { kid: 'x', num: 8, name: 'Event #8', phase: 'In The Money', start: 300, remaining: 0, p: {} },
  };
  st.results = { 7: { rows: [[1, 'Ann Lee', 'TW', 1000]] }, 8: { rows: [[2, 'Bo Chan', 'TW', 500]] } };
  A.repair(st);
  assert.equal(st.events.fd.phase, 'Completed');
  assert.equal(st.events.fd.p['Ann Lee'].st, 'end');
  assert.equal(st.events.x.phase, 'In The Money', 'no winner paid yet: still running');
});

test('people: automatic matching and the docs/people.json fixes', () => {
  const P = require('../docs/people.js');
  const row = (name, cc, prizes, extra) => ({ name, cc, events: 1, bullets: 1, buyins: 100, prizes, cashes: prizes ? 1 : 0, cashedEvents: prizes ? 1 : 0, wins: 0, ev: [{ num: 1, b: 1, buyin: 100, prize: prizes, pos: null }], ...extra });
  const lists = [
    { src: 'a', names: ['apt'], rows: [row('Chen Kuan-Han', 'TW', 50), row('Ann Lee', 'KR', 0), row('Bo Chan', 'HK', 0), row('Bo Chan', 'HK', 0)] },
    { src: 'b', names: ['glpc'], rows: [row('Kuan Han Chen', 'TW', 10), row('Ann Lee', 'US', 5), row('Chengxu Hu', 'CN', 0), row('Bo Chan', 'HK', 1)] },
    { src: 'triton', names: ['triton'], rows: [row('Cheng Xu Hu', 'CN', 7), row('Bo Chan', 'HK', 2)] },
  ];
  const find = (ps, name) => ps.filter((p) => Object.values(p.rows).some((r) => (r.names || [r.name]).includes(name)));
  let ps = P.match(lists);
  assert.equal(find(ps, 'Kuan Han Chen').length, 1, 'word order and hyphens: one person');
  assert.equal(Object.keys(find(ps, 'Kuan Han Chen')[0].rows).length, 2);
  assert.equal(find(ps, 'Ann Lee').length, 2, 'other countries: two people');
  assert.notEqual(find(ps, 'Chengxu Hu')[0], find(ps, 'Cheng Xu Hu')[0], 'split differently: two until people.json says so');
  ps = P.match(lists, P.rules({ same: [['Ann Lee', 'Ann Lee'], ['Chengxu Hu', 'Cheng Xu Hu']], apart: [{ name: 'Bo Chan', people: [['apt'], ['glpc', 'triton']] }] }));
  assert.equal(find(ps, 'Ann Lee').length, 1, '"same" merges other countries');
  assert.equal(find(ps, 'Chengxu Hu')[0], find(ps, 'Cheng Xu Hu')[0], '"same" merges other spellings');
  const bo = find(ps, 'Bo Chan');
  assert.equal(bo.length, 2, '"apart" splits by series');
  const inApt = bo.find((p) => p.rows.a);
  assert.deepEqual(Object.keys(inApt.rows), ['a']);
  assert.equal(inApt.rows.a.bullets, 2, 'two rows of one series under one "apart" person are merged');
  assert.deepEqual(Object.keys(bo.find((p) => !p.rows.a).rows).sort(), ['b', 'triton']);
  assert.deepEqual(P.rules({ same: [[]], apart: [{ name: 'y', people: [['a']] }] }).problems.length, 2, 'malformed fixes are reported');
  // the file itself is valid
  const json = read('people.json');
  assert.deepEqual(P.rules(json).problems, []);
});

test('APT: one player under two spellings in a series is one player', () => {
  A.configure({ series: 'test' });
  const st = A.emptyState();
  st.events = {
    f1: { kid: 'f1', num: 69, name: 'Event #69', phase: 'Completed', start: 100, p: { 'Cheng Yu Chung': { b: 1, st: 'x', f: 100, x: [], cc: 'TW', reg: 1 } } },
    f2: { kid: 'f2', num: 70, name: 'Event #70', phase: 'Completed', start: 200, p: { 'Le Tuan Anh': { b: 1, st: 'x', f: 200, x: [], cc: 'VN', reg: 1 }, 'Le Anh Tuan': { b: 1, st: 'x', f: 200, x: [], cc: 'VN', reg: 1 } } },
  };
  st.results = { 69: { rows: [[1, 'Cheng-Yu Chung', 'TW', 1000]] } };
  A.repair(st);
  const ps = A.players(st);
  const c = ps.filter((p) => /chung/i.test(p.name));
  assert.equal(c.length, 1, 'registration and payout spellings are one player');
  assert.equal(c[0].name, 'Cheng-Yu Chung', 'the payout spelling stays');
  assert.equal(c[0].bullets, 1, 'and its cash is not an extra bullet');
  assert.equal(ps.filter((p) => /^Le /.test(p.name)).length, 2, '"Le Tuan Anh" and "Le Anh Tuan" are two names');
});

test('GOP: bullets are purchases, counted once across flights, holding tables and later days', () => {
  const G = require('../docs/gop/gop.js').configure({ series: 'test' });
  const st = G.emptyState(), now = Math.floor(Date.UTC(2027, 1, 20) / 1000);
  const at = (h) => Math.floor(Date.UTC(2027, 1, 12, h) / 1000);
  // #5: Flight A (Ann twice, Bo), Flight B (Cy), holding table (Bo from A), Day 2 (Ann, Cy carried; Di new); a "DO NOT USE" copy
  const ev = (kid, name, number, start, extra) => ({ kid, title: name, name, number: String(number), num: number, start, phase: 'Completed', p: {}, polls: 1, entries: 0, ...extra });
  st.events = {
    a: ev('a', 'Main Event - Flight A', 5, at(1), { entries: 3 }), b: ev('b', 'Main Event - Flight B', 5, at(5), { entries: 1 }),
    h: ev('h', 'Main Event - (Flight A - ITM) - ITM Holding', 5, at(0), { entries: 1 }), d2: ev('d2', 'Main Event - Day 2', 5, at(24), { entries: 5 }),
    s1: ev('s1', 'Satellite to Main Event', 0, at(2), { entries: 1 }), s2: ev('s2', 'Satellite to Main Event', 0, at(30), { entries: 1 }),
  };
  st.people = { ann: ['Ann Lee', 'TW'], bo: ['Bo Chan', 'HK'], cy: ['Cy Wu', 'TW'], di: ['Di Ko', 'KR'], ann2: ['Lee Ann', 'TW'] };
  //            [pid, purchase, bought, busted, table, seat, chips]
  st.events.a.q = [['ann', 'p1', at(1), at(2)], ['ann', 'p2', at(2) + 60, 0], ['bo', 'p3', at(1), 0]];
  st.events.b.q = [['cy', 'p4', at(5), 0]];
  st.events.h.q = [['bo', 'p3', at(1), 0]];
  st.events.d2.q = [['ann', 'p2', at(2) + 60, at(25)], ['cy', 'p4', at(5), 0], ['di', 'p5', at(24), at(26)]];
  st.events.s1.q = [['bo', 'p6', at(2), 0]]; st.events.s2.q = [['bo', 'p7', at(30), 0]];
  st.events.d2.pay = [[1, 'cy', 1000], [2, 'ann2', 600], [3, 'bo', 300]]; // 'ann2': Ann's second profile (her name in another order)
  G.build(st, now);
  const b = (kid, n) => (st.events[kid].p[n] || {}).b;
  assert.deepEqual([b('a', 'Ann Lee'), b('a', 'Bo Chan'), b('b', 'Cy Wu'), b('h', 'Bo Chan'), b('d2', 'Ann Lee'), b('d2', 'Di Ko')], [2, 1, 1, 0, 0, 1]);
  assert.equal(st.events.h.p['Bo Chan'].carry, 1, 'the holding table carries Bo over');
  assert.equal(st.events.a.p['Ann Lee'].r[0], at(2) + 60, 'the re-entry at its purchase time');
  assert.deepEqual(st.results[5].rows.map((r) => r[1]), ['Cy Wu', 'Ann Lee', 'Bo Chan'], "a second profile's payout goes to the entrant");
  const p = G.players(st).find((x) => x.name === 'Ann Lee');
  assert.equal(p.bullets, 2); assert.equal(p.prizes, 600); assert.equal(p.partial, false);
  assert.equal(G.watchedFromStart(st, 5), true, '5 purchases for 5 entries');
  assert.notEqual(st.events.s1.num, st.events.s2.num, 'same-named side events on different days are two events');
  assert.equal(G.numLabel(st.events.s1.num), '', 'made-up numbers are not shown');
  // GOP's "DO NOT USE" duplicates are dropped from the list
  G.configure({ series: 'test' });
  const s2 = G.emptyState();
  const t = (id, title) => ({ kholdem_id: id, title, eventNumber: '7', startTime: '2027-02-12T12:00:00', timezone: 'Asia/Taipei', phase: { code: 'concluded' }, status: {} });
  require('../docs/gop/gop.js'); // (mergeList is internal: go through a fake fetch)
  return G.pollOnce(s2, { backfill: false, fetchFn: async (u) => ({ ok: true, json: async () => ({ nodes: [null, { type: 'data', data: [{ events: 1 }, { events: 2 }, [3, 4], { kholdem_id: 5, title: 6 }, { kholdem_id: 7, title: 8 }, 'x1', 'Main - Flight A', 'x2', '*(DO NOT USE) Main - Flight A'] }] }) }) })
    .then(() => { assert.deepEqual(Object.keys(s2.events), ['x1']); });
});

test('GOP and ZSOP archives: index and files agree, every played event adds up, rates for every event', () => {
  for (const org of ['gop', 'zsop']) {
    const G = require(`../docs/${org}/${org}.js`);
    const ix = read(`${org}/archive/index.json`);
    assert.ok(ix.series.length > 0, `${org}: archive`);
    const files = fs.readdirSync(path.join(DOCS, `${org}/archive`)).filter((f) => f.endsWith('.json') && !['index.json', 'fx.json'].includes(f));
    assert.deepEqual(files.map((f) => f.slice(0, -5)).sort(), ix.series.map((s) => s.id).sort());
    FX.seed(read(`${org}/archive/fx.json`));
    for (const f of ix.series) {
      for (const k of ['id', 'name', 'place', 'tag', 'start', 'end', 'tz', 'currency']) assert.ok(f[k], `${f.id}: no ${k}`);
      const st = read(`${org}/archive/${f.id}.json`); G.repair(st);
      assert.equal(st.org, org, `${f.id}: org`);
      const ev = Object.values(st.events);
      assert.ok(ev.every((e) => e.phase === 'Completed' && e.polls), `${f.id}: every event read and finished`);
      assert.ok(f.known >= f.played - 2, `${f.id}: every bullet known in only ${f.known} of ${f.played} events`);
      assert.ok(G.players(st).length > 0);
      for (const e of ev) assert.notEqual(FX.factor(e.currency, 'USD', FX.ymd(e.start)), null, `${f.id}: ${e.currency} on ${FX.ymd(e.start)}`);
      if (org === 'zsop') {
        // ZSOP's own codes: the Zodiac events Z1-Z12, none of them a satellite
        const labels = Object.values(st.labels || {});
        assert.ok(labels.filter((l) => /^Z\d+/.test(l)).length >= 10, `${f.id}: Zodiac events labelled (${labels.join(' ')})`);
        for (const [n, l] of Object.entries(st.labels)) {
          assert.equal(G.numLabel(Number(n), st), /^\d/.test(l) ? '#' + l : l);
          if (/^Z\d/.test(l)) assert.ok(!ev.some((e) => e.num === Number(n) && e.sat), `${f.id}: ${l} isn't a satellite`);
        }
        assert.ok(ev.some((e) => e.sat), `${f.id}: satellites known`);
      }
    }
  }
});

test('ZSOP: a series list grouped by day, its own event codes and satellites; GOP keeps its numbers', async () => {
  const Z = require('../docs/zsop/zsop.js').configure({ series: 'test' }), G = require('../docs/gop/gop.js');
  assert.equal(Z.SITE, 'https://zodiacseriesofpoker.com'); assert.equal(G.SITE, 'https://godsofpoker.com');
  G.configure({ series: 'gop-x' }); Z.configure({ series: 'test' });
  assert.equal(G.SERIES, 'gop-x', 'configuring ZSOP leaves GOP alone');
  for (const [n, later] of [['High Roller Single Day 6 Max', false], ['NLH Day 8 Handed', false], ['Main Event Day 2', true], ['Zodiac Rooster Starter Final Day', true]]) assert.equal(Z.isLaterDay(n), later, n);
  const t0 = '2026-09-03T11:00:00';
  const ev = (kid, n, title, extra) => ({ kholdem_id: kid, eventNumber: n, title, startTime: t0, currency: 'NT$', totalBuyin: 10000, totalEntries: 0, phase: { code: 'scheduled' }, status: {}, ...extra });
  const list = { festival: { title: 'The Test Horse', subtitle: 'ZSOP Taipei 2026', slug: 'test', timezone: 'Asia/Taipei', currency: 'NT$', start_date: '2026-09-03T02:00:00.000Z', end_date: '2026-09-14T16:00:00.000Z' },
    events: { '2026-09-03T00:00:00': [ev('s1', 1, 'S1 - Milestone Sat to Rooster Starter', { satellite: true }), ev('z1', 2, 'Z1 - Zodiac Rooster Starter', { isSummary: true }), ev('z1a', 2, 'Z1 - Zodiac Rooster Starter Day 1A', { satellite: false })],
      '2026-09-04T00:00:00': [ev('z1f', 2, 'Z1 -  Zodiac Rooster Starter Final Day'), ev('x', 0, 'QQPK x ZSOP Exclusive'), ev('p', 3, '1 - PLO')] } };
  // a SvelteKit data file: node 0 the layout, node 1 the page (flattened)
  const flat = (o) => { const out = []; const add = (v) => { const i = out.length; out.push(null); out[i] = v && typeof v === 'object' ? (Array.isArray(v) ? v.map(add) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, add(x)]))) : v; return i; }; add(o); return out; };
  const fetchFn = async (u) => ({ ok: /\/series\/test\//.test(u), status: 404, json: async () => ({ type: 'data', nodes: [{ type: 'data', data: flat({}) }, { type: 'data', data: flat(list) }] }) });
  const st = Z.emptyState();
  await Z.pollOnce(st, { fetchFn });
  assert.equal(st.org, 'zsop');
  assert.deepEqual(Object.keys(st.events).sort(), ['p', 's1', 'x', 'z1a', 'z1f'], 'the summary left out');
  assert.equal(st.events.z1a.name, 'Zodiac Rooster Starter Day 1A', 'the code is the label, not part of the name');
  assert.equal(st.events.z1a.currency, 'TWD');
  assert.ok(st.events.s1.sat && !st.events.z1a.sat, 'satellites as the list says');
  assert.equal(Z.numLabel(st.events.z1f.num, st), 'Z1'); assert.equal(Z.numLabel(st.events.p.num, st), '#1'); assert.equal(Z.numLabel(st.events.x.num, st), '');
  assert.equal(st.festival.subtitle, 'ZSOP Taipei 2026');
  assert.equal(G.numLabel(12), '#12');
});

test('docs/gop/index.html and docs/zsop/index.html are the APT page made by tools/stamp.sh (edit the APT page, then run it)', () => {
  const strip = (f, drop) => fs.readFileSync(path.join(DOCS, f), 'utf8').split('\n').filter((l) => !drop.some((re) => re.test(l)));
  const common = [/^<html /, /^<title>/, /^<script src="[^"]*(tracker|gop|zsop)\.js/, /^<!-- Made by tools\/stamp\.sh/, /^<script src="\.\.\/(fx|series)\.js/];
  for (const org of ['gop', 'zsop']) {
    assert.deepEqual(strip(`${org}/index.html`, common), strip('apt/index.html', common));
    assert.match(fs.readFileSync(path.join(DOCS, `${org}/index.html`), 'utf8'), new RegExp(`<html lang="en" data-org="${org}">`));
  }
  // ZSOP's engine is made from GOP's: GOP's loads first
  assert.match(fs.readFileSync(path.join(DOCS, 'zsop/index.html'), 'utf8'), /gop\/gop\.js[^\n]*\n<script src="zsop\.js/);
});

test('RPT: watched live, a new seat is a re-entry and a bust is timed by the poll that sees it', async () => {
  const R = require('../docs/rop/rop.js').configure({ series: 'test' });
  const st = R.emptyState();
  const start = Math.floor(Date.now() / 1000) - 3600;
  const ev = (id, name, extra) => ({ publicId: id, name, seriesPublicId: 'srs_main', seriesGroupPublicId: 'grp', startTime: new Date(start * 1000).toISOString(), buyIn: 1000, fee: 100, buyInCurrency: 'VND', status: 'running', totalEntry: 3, ...extra });
  let standings = { e1: [], fd: [] }, payouts = { e1: [], fd: [] }, events = [ev('e1', '#7 - MAIN - DAY 1A'), ev('fd', '#7 - MAIN - FINAL DAY', { status: 'scheduled', startTime: new Date((start + 86400) * 1000).toISOString(), flightGroupEntries: 3 })];
  const row = (pid, name, seat, busted) => ({ playerPublicId: pid, playerName: name, seatPublicId: seat, country: 'VN', isBusted: busted, stack: busted ? 0 : 1000, tableNumber: 1, seatNumber: 2, rank: 1 });
  const fetchFn = async (u) => {
    const url = new URL(u), p = url.pathname;
    const body = p.endsWith('/series-groups') ? { data: [{ slug: 'test', publicId: 'grp', name: 'Test', startDate: '2026-01-01', endDate: '2027-01-01', effectiveStatus: 'active' }] }
      : p.endsWith('/public/events') ? { data: events, pagination: { currentPage: 1, totalPages: 1 } }
      : p.endsWith('/standings') ? { data: standings[p.split('/').at(-2)], pagination: { currentPage: 1, totalPages: 1 } }
      : { payouts: payouts[p.split('/').at(-2)] };
    return { ok: true, json: async () => body };
  };
  standings.e1 = [row('a', 'TRẦN ĐỨC HÙNG', 's1', false), row('b', 'Bo', 's2', false)];
  await R.pollOnce(st, { fetchFn });
  standings.e1 = [row('a', 'TRẦN ĐỨC HÙNG', 's3', false), row('b', 'Bo', 's2', true)]; // Hùng re-entered (new seat), Bo busted
  await R.pollOnce(st, { fetchFn, listEvery: 1e9 });
  const e1 = st.events.e1;
  const hung = e1.p['Trần Đức Hùng'];
  assert.ok(hung, 'names typed in capitals are shown in normal case');
  assert.equal(hung.b, 2); assert.equal(hung.r.length, 1); assert.equal(hung.x.length, 1, 'the bust before the re-entry');
  assert.equal(e1.p.Bo.st, 'x'); assert.equal(e1.p.Bo.x.length, 1);
  assert.deepEqual(st.feed.map((f) => f.k).sort(), ['bust', 'bust', 'reentry']);
  // Final day: carried over; results are its places plus flight cashes by players who didn't reach it
  events = events.map((e) => ({ ...e, status: 'completed' }));
  standings.fd = [row('a', 'TRẦN ĐỨC HÙNG', 's3', true)];
  payouts.e1 = [{ winners: [{ rank: 2, playerPublicId: 'b', playerName: 'Bo', amount: 500 }, { rank: 1, playerPublicId: 'a', playerName: 'TRẦN ĐỨC HÙNG', amount: 500 }] }];
  payouts.fd = [{ winners: [{ rank: 1, playerPublicId: 'a', playerName: 'TRẦN ĐỨC HÙNG', amount: 3000 }] }];
  st.listAt = 0; await R.pollOnce(st, { fetchFn });
  assert.equal(st.events.fd.p['Trần Đức Hùng'].carry, 1);
  assert.deepEqual(st.results[7].rows.map((r) => [r[0], r[1], r[3]]), [[1, 'Trần Đức Hùng', 3000], [2, 'Bo', 500]]);
  assert.equal(st.events.fd.p['Trần Đức Hùng'].st, 'end', 'a finished event marks its winner busted: not a bust');
});

test('RPT archive: index and files agree, results match the prize pools, rates for every event', () => {
  const R = require('../docs/rop/rop.js');
  const ix = read('rop/archive/index.json');
  assert.ok(ix.series.length > 0);
  const files = fs.readdirSync(path.join(DOCS, 'rop/archive')).filter((f) => f.endsWith('.json') && !['index.json', 'fx.json'].includes(f));
  assert.deepEqual(files.map((f) => f.slice(0, -5)).sort(), ix.series.map((s) => s.id).sort());
  FX.seed(read('rop/archive/fx.json'));
  for (const f of ix.series) {
    const st = read(`rop/archive/${f.id}.json`); R.repair(st);
    const ev = Object.values(st.events);
    assert.ok(ev.every((e) => e.phase === 'Completed'), `${f.id}: finished`);
    assert.ok(R.players(st).length > 0, `${f.id}: players`);
    let ok = 0, n = 0;
    for (const [num, r] of Object.entries(st.results)) {
      const kids = ev.filter((e) => e.num === Number(num));
      const pool = Math.max(0, ...kids.map((e) => e.prizePool || 0)); if (!pool || kids.some((e) => e.sat)) continue; // (satellites pay seats)
      const paid = r.rows.reduce((a, x) => a + x[3], 0);
      n++; if (Math.abs(paid - pool) <= pool * 0.02) ok++;
      // amounts in the wrong unit (the site's thousands of VND) would be off by 1000x
      assert.ok(paid <= pool * 3 && paid >= pool / 30, `${f.id} #${num}: paid ${paid} for a prize pool of ${pool}`);
    }
    // Championship III's own payouts and prize pools disagree in a third of its events (the site's figures)
    if (f.id !== 'rpt-championship-iii') assert.ok(ok >= n * 0.95, `${f.id}: results match the prize pool in ${ok} of ${n} events`);
    for (const e of ev) assert.notEqual(FX.factor(e.currency, 'USD', FX.ymd(e.start)), null, `${f.id}: ${e.currency} on ${FX.ymd(e.start)}`);
  }
});

test('docs/rop/index.html is the APT page made by tools/stamp.sh', () => {
  const strip = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8').split('\n').filter((l) => ![/^<html /, /^<title>/, /^<script src="[^"]*(tracker|gop|rop)\.js/, /^<!-- Made by tools\/stamp\.sh/, /^<script src="\.\.\/(fx|series)\.js/].some((re) => re.test(l)));
  assert.deepEqual(strip('rop/index.html'), strip('apt/index.html'));
});

test('Grand Loyal archives (GLPC, USOP): index and files agree, finished, payouts within the pools, rates', () => {
  const G = require('../docs/glpc/glpc.js');
  for (const org of ['glpc', 'usop']) {
    const ix = read(`${org}/archive/index.json`);
    assert.ok(ix.series.length > 0, `${org}: archive`);
    const files = fs.readdirSync(path.join(DOCS, org, 'archive')).filter((f) => f.endsWith('.json') && !['index.json', 'fx.json'].includes(f));
    assert.deepEqual(files.map((f) => f.slice(0, -5)).sort(), ix.series.map((s) => s.id).sort());
    FX.seed(read(`${org}/archive/fx.json`));
    for (const f of ix.series) {
      assert.ok(Series.LIST.some((s) => s.org === org && s.source.series === f.id), `${f.id}: an entry in docs/series.js`);
      const st = read(`${org}/archive/${f.id}.json`); G.repair(st);
      const ev = Object.values(st.events);
      assert.ok(ev.every((e) => e.phase === 'Completed'), `${f.id}: finished`);
      assert.ok(G.players(st).length > 0, `${f.id}: players`);
      // Grand Loyal keeps only the top places of a finished event: never more than its pool
      for (const [num, r] of Object.entries(st.results)) {
        const kids = ev.filter((e) => e.num === num); if (kids.some((e) => e.sat)) continue;
        const pool = Math.max(0, ...kids.map((e) => e.prizePool || 0)); if (!pool) continue;
        assert.ok(r.rows.reduce((a, x) => a + x[3], 0) <= pool * 1.5, `${f.id} #${num}: paid more than its pool`);
      }
      for (const e of ev) assert.notEqual(FX.factor(e.currency || 'VND', 'USD', FX.ymd(e.start)), null, `${f.id}: ${e.currency || 'VND'} on ${FX.ymd(e.start)}`);
    }
  }
});

test('docs/usop/index.html is the GLPC page made by tools/stamp.sh', () => {
  const strip = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8').split('\n').filter((l) => ![/^<html /, /^<script src="[^"]*glpc\.js/, /^<!-- Made by tools\/stamp\.sh/, /^<script src="\.\.\/(fx|series)\.js/].some((re) => re.test(l)));
  assert.deepEqual(strip('usop/index.html'), strip('glpc/index.html'));
});
