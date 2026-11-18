#!/usr/bin/env node
// Small questions the "Poll series" workflow asks about docs/series.js:
//   node poller/ctl.js active              ids of the series to poll now (from the day before they start to two days after)
//   node poller/ctl.js branch <id>         the series' data branch
//   node poller/ctl.js over <id> <state>   exit 0 when the series is over (no next run needed), 1 otherwise
'use strict';
const fs = require('fs');
const Series = require('../docs/series.js');
const [cmd, id, statePath] = process.argv.slice(2);
const entry = () => {
  const s = Series.byId(id || '');
  if (!s) { console.error(`Unknown series "${id || ''}". Known: ${Series.LIST.map((x) => x.id).join(', ')}`); process.exit(2); }
  return s;
};
if (cmd === 'active') console.log(Series.LIST.filter(Series.pollable).map((s) => s.id).join('\n'));
else if (cmd === 'branch') console.log(entry().branch);
else if (cmd === 'over') {
  const s = entry(); let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const done = Series.over(s, state);
  console.log(done ? `${s.id} is over` : `${s.id} is still on`);
  process.exit(done ? 0 : 1);
} else { console.error('usage: ctl.js active | branch <id> | over <id> <state.json>'); process.exit(2); }
