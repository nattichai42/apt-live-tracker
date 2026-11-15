#!/usr/bin/env node
// Runs the tracker in a loop and periodically publishes state to the `data` branch.
// Usage: node poller/poll.js --state state/state.json --minutes 345 --min-interval 10 --budget 1 --publish-every 3 [--no-publish]
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
// Poll as fast as the request budget allows: interval = requests in a round / budget, clamped to [min, max].
// The site refused nothing at 6 req/s in a short test; 1 req/s on average keeps a wide margin.
const minInterval = Number(opt('min-interval', 10));
const maxInterval = Number(opt('max-interval', 60));
const budget = Number(opt('budget', 1)); // requests per second, on average
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
  let lastPublish = 0, round = 0, interval = minInterval, backoff = 0, clean = 0;
  while (Date.now() < end) {
    const t0 = Date.now();
    round++;
    try {
      const s = await T.pollOnce(state, { fetchFn, interval, listEvery: 180, resultsEvery: 60, finalEvery: 300, evEvery: 60, concurrency: 4 });
      save(state);
      if (s.throttled) {
        // The site pushed back: double the wait (1 min to 10 min), honour Retry-After
        backoff = Math.min(600, Math.max(60, backoff * 2, s.retryAfter || 0)); clean = 0;
      } else if (backoff && ++clean >= 10) { backoff = backoff / 2 < 60 ? 0 : backoff / 2; clean = 0; }
      interval = Math.max(backoff, Math.min(maxInterval, Math.max(minInterval, s.requests / budget)));
      console.log(`[${new Date().toISOString()}] round ${round}: ${s.events} events, ${s.requests} requests, next in ${Math.round(interval)}s${backoff ? ' (backing off)' : ''}, +${s.entries} entries, ${s.busts} busts, ${s.reentries} re-entries${s.errors.length ? ', errors: ' + s.errors.join(' | ') : ''}`);
    } catch (e) {
      console.error('round failed:', e);
    }
    if (Date.now() - lastPublish >= publishEvery * 60_000) { publish(); lastPublish = Date.now(); }
    const wait = interval * 1000 * (0.9 + Math.random() * 0.2) - (Date.now() - t0); // ±10% jitter
    if (Date.now() + wait >= end) break;
    if (wait > 0) await sleep(wait);
  }
  save(state);
  publish();
})();
