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
    const c = JSON.parse(JSON.stringify(st)); A.repair(c);
    assert.deepEqual(c.events, st.events, `${f.id}: repair() would still change it (run apt-archive.js --repack)`);
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
  assert.deepEqual(P.rules({ same: [['x']], apart: [{ name: 'y', people: [['a']] }] }).problems.length, 2, 'malformed fixes are reported');
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
