#!/usr/bin/env node
// Small questions the "Poll series" workflow asks about docs/series.js:
//   node poller/ctl.js active              ids of the series to poll now (from the day before they start to two days
//                                          after), leaving out those already archived from what the poller saw
//   node poller/ctl.js branch <id>         the series' data branch
//   node poller/ctl.js over <id> <state>   exit 0 when the series is over (no next run needed), 1 otherwise
//   node poller/ctl.js archive <id> <state>  save a finished series in its organiser's archive (docs/<org>/archive/);
//                                          exit 0 when saved, 3 when its organiser has no archive
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Series = require('../docs/series.js');
const [cmd, id, statePath] = process.argv.slice(2);
const entry = () => {
  const s = Series.byId(id || '');
  if (!s) { console.error(`Unknown series "${id || ''}". Known: ${Series.LIST.map((x) => x.id).join(', ')}`); process.exit(2); }
  return s;
};
// Saved in its organiser's archive from the poller's own record (a file saved from the organiser's site afterwards
// doesn't count: the live record has more)
function archived(s) {
  const a = Series.ORGANISERS[s.org].archive; if (!a) return false;
  try {
    const ix = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs', a.dir, 'index.json'), 'utf8'));
    return (ix[a.list] || []).some((x) => x.id === Series.archiveId(s) && x.watched);
  } catch { return false; }
}
if (cmd === 'active') console.log(Series.LIST.filter((s) => Series.pollable(s) && !archived(s)).map((s) => s.id).join('\n'));
else if (cmd === 'branch') console.log(entry().branch);
else if (cmd === 'over') {
  const s = entry(); let state = null;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const done = Series.over(s, state);
  console.log(done ? `${s.id} is over` : `${s.id} is still on`);
  process.exit(done ? 0 : 1);
} else if (cmd === 'archive') {
  const s = entry(), a = Series.ORGANISERS[s.org].archive;
  if (!a) { console.log(`${Series.ORGANISERS[s.org].name} has no archive: ${s.id} stays on its data branch (${s.branch})`); process.exit(3); }
  if (!fs.existsSync(statePath || '')) { console.error(`no saved state at ${statePath}`); process.exit(2); }
  execFileSync(process.execPath, [path.join(__dirname, '..', a.tool), '--series', s.id, '--from-state', statePath], { stdio: 'inherit' });
} else { console.error('usage: ctl.js active | branch <id> | over <id> <state.json> | archive <id> <state.json>'); process.exit(2); }
