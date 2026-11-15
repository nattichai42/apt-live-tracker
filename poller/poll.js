#!/usr/bin/env node
// Runs the tracker in a loop and periodically publishes state to the `data` branch.
// Usage: node poller/poll.js --state state/state.json --minutes 55 --interval 60 --publish-every 3 [--no-publish]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../docs/tracker.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const statePath = opt('state', 'state/state.json');
const minutes = Number(opt('minutes', 55));
const interval = Number(opt('interval', 60));
const publishEvery = Number(opt('publish-every', 3));
const noPublish = flag('no-publish');

const fetchFn = (url) => fetch(url, { headers: { 'User-Agent': 'apt-live-tracker (github actions)', Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(30000) });

function load() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return T.emptyState(); }
}
function save(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}
function publish() {
  if (noPublish) return;
  try { execFileSync('bash', [path.join(__dirname, 'publish.sh'), statePath], { stdio: 'inherit' }); }
  catch (e) { console.error('publish failed:', e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const state = load();
  const end = Date.now() + minutes * 60_000;
  let lastPublish = 0, round = 0;
  while (Date.now() < end) {
    const t0 = Date.now();
    round++;
    try {
      const s = await T.pollOnce(state, { fetchFn, interval, listEvery: 180, resultsEvery: 300, concurrency: 4 });
      save(state);
      console.log(`[${new Date().toISOString()}] round ${round}: ${s.events} events, +${s.entries} entries, ${s.busts} busts, ${s.reentries} re-entries${s.errors.length ? ', errors: ' + s.errors.join(' | ') : ''}`);
    } catch (e) {
      console.error('round failed:', e);
    }
    if (Date.now() - lastPublish >= publishEvery * 60_000) { publish(); lastPublish = Date.now(); }
    // Nothing running and nothing starting soon: stop early to save Actions minutes (next scheduled run resumes)
    const nowS = Math.floor(Date.now() / 1000);
    const soon = Object.values(state.events).some((e) => e.phase !== 'Completed' && e.start && e.start <= nowS + 900);
    if (!T.activeKids(state, nowS).length && !soon) { console.log('No live events; exiting early.'); break; }
    const wait = interval * 1000 - (Date.now() - t0);
    if (Date.now() + wait >= end) break;
    if (wait > 0) await sleep(wait);
  }
  save(state);
  publish();
})();
