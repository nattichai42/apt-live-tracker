# Live poker series trackers

Real-time bust and re-entry tracking for live poker series (APT, GLPC, Triton so far), built on each organiser's
public live data, plus an all-series page that matches players across every series.

- **Pages** (`docs/`, served by GitHub Pages): one page per organiser (`docs/apt/`, `docs/glpc/`, `docs/triton/`)
  with a bust feed, live event cards and a player table (bullets, buy-ins, prizes, net, ITM %); a home page; and
  `docs/all/`, every player across every series.
- **Poller** (`poller/`, run by GitHub Actions): polls each running series around the clock and saves its record to the
  series' data branch as `state.json`, so a page has full history when you open it.
- **Series list** (`docs/series.js`): every series in one place. Pages, home banners, footer links, the all-series page
  and the poller all read it.

## Adding a series

**Same organiser** (the next APT stop, GLPC VII, a new Triton festival): add one entry to `LIST` in `docs/series.js`,
copying one of that organiser's and changing:

- `id` (never change it later), `branch` (a new data branch name, e.g. `apt-manila-2027-data`)
- `name`, `tag`, `place`, `tz`, `currency`, `start`, `end` (venue dates), `link`
- the banner fields (`title`, `mark`, `sub`, `art`, `watermark`)
- `source`, what the engine needs to find it:
  - APT: `{ series: '<slug from theasianpokertour.com/series/<slug>>' }`
  - GLPC: `{ series, seriesUrl, from, to }` (the tournaments listed between those dates)
  - Triton: `{ festival: '<festival id from tritonpoker.plus/festival/<id>>', series }`
  - Gods of Poker: `{ series: '<slug from godsofpoker.com/series/<slug>>' }`
  - ZSOP: `{ series: '<slug from zodiacseriesofpoker.com/series/<slug>>' }`
  - Royal Poker Tour: `{ series: '<festival slug, as in api.royal-poker.com/api/v1/public/series-groups>' }`

Then run `tools/stamp.sh` and push. The *Poll series* workflow starts polling it the day before it starts, and stops two days after it
ends. To start it earlier, run that workflow by hand with the series id. Its page is
`<organiser page>?s=<id>`; the organiser's page without `?s=` shows its running series (else the next, else the latest).
A Triton festival also joins the Triton all-time view, and the all-series page picks every series up by itself.

**When a series ends** nothing needs doing. Once it is over (`over()` in `docs/series.js`: two days past its last day, or
its last day has come and every event has finished), its poller's last run polls 20 more minutes for late payouts, then
saves the series in its organiser's archive from its own record (`node poller/ctl.js archive <id> state.json`, which runs
the organiser's archive tool with `--series <id> --from-state`) and commits that to main. From then on the home page shows
it under Past and the scheduled start leaves it alone. GLPC has no archive yet: a finished GLPC series stays on its data
branch, and its page keeps reading it from there. If that commit ever fails (the run says so), run the same command on a
copy of the series' `state.json` from its data branch and push.

**New organiser**: write an engine `docs/<org>/<org>.js` with the same interface as the others: `configure(source)`,
`emptyState`, `pollOnce`, `repair`, `players(state, { detail, fromStart, finished })`, `playerTimeline`,
`completedEvents`, `liveEvents`, `upcoming`, `eventFinished`, `watchedFromStart`, `eventPlayers` and `canon`.
Copy the closest page into `docs/<org>/index.html` and point it at the new engine. Add the organiser to `ORGANISERS` in
`docs/series.js` (with `poll` pace), and add a `<script>` for the engine to `docs/all/index.html` and a line to
`tools/stamp.sh`. If its events read differently (flights, later days, currency per event), add an `ADAPT` entry in
`docs/all/all.js`. Then add its series as above. For its finished series to be saved for good, give it an `archive` entry in `ORGANISERS`
and a tool taking `--series <id> --from-state <state.json>` (see `tools/apt-archive.js`).

## How busts and re-entries are detected

The site lists who is seated in each running event, but not who busted or how many bullets they fired.
Consecutive snapshots are compared:

| Seen | Recorded as |
| --- | --- |
| A player's seat disappears | Bust, at the time of that poll |
| A busted player sits down again | Re-entry (bullet + 1) |
| A player reappears in the same seat within a few polls | Data glitch, the bust is undone |
| A new name appears | New entry |

`Untracked` on an event card = official entries − bullets seen. It covers bullets fired before tracking
began and bust + re-entry faster than one poll. Chip counts on the site are not live, so they are not used.

## Setup

1. Make this repository **public** (needed for free Actions minutes and Pages).
2. **Settings → Pages**: Source *Deploy from a branch*, branch `main`, folder `/docs`.
3. **Settings → Actions → General → Workflow permissions**: *Read and write permissions*.
4. Nothing to start by hand. The *Poll series* workflow (`.github/workflows/poll.yml`) runs every 15 minutes and starts a
   poller for each series in its dates. Each poller job polls for ~5 h 45 min. When it starts, it queues the next run
   of its series, which waits in that series' concurrency group and takes over the moment it ends. The schedule is only a
   backup. Queueing stops two days after the series ends, or once its last day has come and every event has finished;
   that last run archives it (see "When a series ends").
5. Open `https://<owner>.github.io/<repo>/` (home).

To pause everything, disable the workflow in the Actions tab.

## Tests

The *Tests* workflow runs on every push to main that touches the site, tools or poller, and on pull requests:

- `npm test` (`tests/data.test.js`, offline, no dependencies): the series list is complete and shares no id, branch or
  storage key; when polling starts, stops and counts as over; `poller/ctl.js` answers; every APT archive file is in its
  index, in the current packed form and convertible to USD from `fx.json` alone; Triton's `all.json` gives exactly the
  players and timelines of its festival files; engine rules such as a paid winner finishing an event.
- `npm run test:pages` (`tests/pages.test.js`, Playwright): every page at phone width (375 px), live ones against the
  data branches. It fails on a script error, NaN / undefined in the text, or anything wider than the screen, after
  opening each tab, its first event and first player. Locally: `npm i --no-save playwright && npx playwright install chromium`.

## Changing the engine

After editing an engine, `docs/fx.js`, `docs/series.js` or `docs/all/all.js`, run `tools/stamp.sh`. It points each
page at its scripts by content hash (`tracker.js?v=<hash>`), so phones never combine a new page with a cached old engine.
If you change what the APT engine's `repair()` does, raise `REPAIR` in `docs/apt/tracker.js` and run
`node tools/apt-archive.js --repack`: saved archives carry the version they were repaired under and pages don't repair
them again on every load (the tests fail until they're re-saved).

## Local run

```bash
node poller/poll.js --series apt-taipei-2026 --state state/state.json --minutes 10 --no-publish
```

## Gods of Poker (`docs/gop/`)

Gods of Poker (godsofpoker.com) runs on the same tournament software as APT, but its pages publish complete records: every
event page lists one row per bullet (its purchase and time), each bust with its time, table and seat, every player's id,
and the payouts. So nothing is inferred from seats changing, and past series are as exact as series watched live.

- `docs/gop/gop.js` reads the series list and the event pages (`/event/<id>/__data.json`), keeps their rows, and rebuilds
  the state from them on every poll in the APT engine's shape. Counting, timelines and event lists are the APT engine's
  (`gop.js` needs `apt/tracker.js` loaded first; `ORGANISERS.gop.needs` says so).
- A bullet is a purchase, counted in the first flight it appears in. Later days and "ITM holding" tables show the same
  purchase for players carried over. Purchases add up to the official entries exactly in 529 of the 531 played events of
  the 7 past series (the other two are a 2-entry Final Day and a Flip-Out stage).
- GOP's "DO NOT USE" leftovers (duplicates of a real flight) and per-event summaries are ignored. Satellites and side
  events numbered 0 get numbers of our own from 1001, which the page doesn't show.
- Players are known by GOP's player id. Profiles with the same name are one player unless they played in one event
  together or their countries disagree; a payout to an entrant's second profile (same name, maybe in another word order)
  is credited to the entrant.
- The site doesn't answer other sites' pages (no CORS), so the page shows what the poller saved and re-reads it every
  minute. The poller reads the events being played about every 30 s (each event page is ~0.5 MB).
- The page is the APT page: `docs/gop/index.html` is made from `docs/apt/index.html` by `tools/stamp.sh` with
  `data-org="gop"` (edit the APT page; a test fails if the copy is behind). Organiser-specific text sits in
  `data-only="apt"` / `data-only="gop"` blocks.
- `node tools/series-archive.js --org gop` saves every finished series (`--only <slug>`, `--force`, `--rates`); the poller archives
  a watched series itself when it ends (`--series <id> --from-state`). Rates for their dates are in `docs/gop/archive/fx.json`
  (`tools/rates.js`, shared with the APT archive).

## Zodiac Series of Poker (`docs/zsop/`)

ZSOP (zodiacseriesofpoker.com; Taipei, Jeju) runs on Gods of Poker's software, so it has the same complete records.

- `docs/gop/gop.js` exports `make({ site, org, labels })` as well as GOP's own engine; `docs/zsop/zsop.js` is that engine
  made for ZSOP's site (load `apt/tracker.js`, then `gop/gop.js`, then `zsop/zsop.js`). The differences it handles: the
  series list comes grouped by day, the series list (not the event page) says which events are satellites, and festivals
  have no "complete" flag (a festival is finished once its end date has passed).
- Events go by ZSOP's own codes at the start of each title: Z1-Z12 the Zodiac events, H High Rollers, S satellites, 1, 2,
  ... side events ("Z6H4" is both). ZSOP's event numbers only group an event's flights and days, so the engine keeps
  them as numbers, takes the code off the name, and keeps `labels` (number -> code) in the state; `numLabel(num, state)`
  shows "Z1" or "#12", and nothing for an event without a code.
- A series has a name and a subtitle ("The Final Horse", "ZSOP Taipei 2026 II"): its archive is named after both and
  placed by the subtitle.
- `node tools/series-archive.js --org zsop` saves every finished series, as for GOP. In the three 2026 series purchases add up
  to the official entries in all 186 played events. Prizes include bounties won, so a bounty event's prizes add up to more
  than its prize pool; a Main Event's payout table can add up to less than the pool shown (ZSOP's own figures).
- Bounties: in knockout (PKO) events the site records the bounty money each purchase won (`knockOutAmount`), cashed or
  not, while the payouts show only those of players who cashed. The engine keeps them per player in `state.bounties`
  (event number -> player -> amount) and a place's prize is then its cash alone, so nothing counts twice; `players()`
  adds them to prizes (not cashes, so ITM is unchanged) and timelines show "Bounties won". Fixed and mystery bounties
  are recorded nowhere, so they stay out of prizes. Gods of Poker's 7 past series have no knockout events with
  recorded bounties (only fixed and mystery ones), so nothing changes there.
- Net across ZSOP is about −20%: fees ~11%, fixed and mystery bounties ~5-8%, Main Events' payout tables a few
  points short of their pools, satellites (their seats aren't prizes) ~2%.
- Not live yet: ZSOP had no next series listed on 20 Nov 2026. When it has, add it to `docs/series.js` with `org: 'zsop'`.

## Royal Poker Tour (`docs/rop/`)

The Royal Poker Tour (royal-poker.com, Vietnam) runs its festivals on its own app, whose public API
(`api.royal-poker.com/api/v1`) lists a festival's events (`/public/events`, filtered by festival) and, for each, its
standings (`/public/events/<id>/standings`: every player, their current seat, busted or not) and payouts.

- `docs/rop/rop.js` builds the APT engine's shape from them, like GOP's engine. The API has no per-player entry counts
  or bust times, so they come from watching: a player back with a new seat id has re-entered, and a bust is timed at
  the poll that first sees it. An event read only after it finished gives each player one bullet (re-entries are in its
  entry count, not credited: bullets are a minimum, as for APT series not watched live).
- Flights and later days share an event's series (`#30 - RPT CHAMPIONSHIP - DAY 1A` ... `FINAL DAY`). A later day's own
  entry count is the players who reached it; the event's total (`flightGroupEntries`) is used there instead.
- Results are the last part's places plus flight cashes by players who didn't reach it; they match each event's prize
  pool in all 117 events of Championship IV.
- Championship III (June 2026) gives amounts in thousands of VND (first prizes below the buy-in, scaled up), and its
  payouts and pools disagree in a third of its events: shown as published. Championships I and II have only their
  schedule on the platform, so they aren't saved.
- Names typed in capitals are shown in normal case ("TRẦN ĐỨC HÙNG" -> "Trần Đức Hùng").
- No CORS: the page shows what the poller saved. `node tools/series-archive.js --org rop` saves finished festivals.
- rptlive.app (mentioned as RPT's live site) didn't answer when this was built (Cloudflare 525); it may be up only
  during festivals.

## GLPC VI (Grand Loyal Poker Championships, 18–29 Nov 2026)

A second tracker with the same views lives in `docs/glpc/` (page at `https://<owner>.github.io/<repo>/glpc/`),
built on the public JSON behind grandloyal.vn's tracker (`apitracker.grandloyal.vn`, the requests its own pages make).

- Engine: `docs/glpc/glpc.js`, record on the `glpc-data` branch (series `glpc-vi`).
- The site lists everyone who registered for an event, each with a player id and a busted flag, plus official entry
  and rebuy counts. A flip to busted is a bust; back in (or the same name registering again) is a re-entry once the
  entry count has gone up. Official rebuys we could not attach to a player show as *missed*.
- Places come from the leaderboard rank, prizes from the payout table (stored by the site in thousands of VND).
- Times from the site are Vietnam wall-clock time with a `Z` suffix; the engine converts them to UTC.
- Later days get their event number from the flights that feed them (`multiDayTourId`); the schedule's reused
  numbers for different single-day events (#14/#15/#16 on 20 and 21 Nov) are kept apart as `#14·2` etc.


### Past GLPC and USOP series (Grand Loyal's tracker)

USOP festivals run on Grand Loyal's tracker too, so `usop` is an organiser of its own on GLPC's engine and page
(`docs/usop/index.html` is made from `docs/glpc/index.html` by `tools/stamp.sh`). Grand Loyal doesn't list which
tournaments belong to which festival, so the past ones are entries in `docs/series.js` with their dates and
`past: true` (never polled; their page opens the archive): GLPC III, IV and V, USOP Hanoi 2025 (also called "GLPC -
Powered by USOP"), USOP Vietnam May and August 2026. `node tools/series-archive.js --org glpc|usop` saves them
(`readPast()` in the engine reads every event once: the site keeps old events "active"); GLPC VI is archived by its
poller when it ends, like every watched series.

- A finished event's leaderboard has one row per player and its counts include the re-entries: bullets are a minimum.
- Grand Loyal keeps only the top few places of a finished event's payouts (the Main Event's Final Day: 3), so past
  results are winners and podiums, not every cash. GLPC VI, watched live, has the full tables.
- GLPC V has only 27 tournaments on the tracker (11 played): the festival is only partly recorded there.

### USOP stops outside Grand Loyal's tracker (SoMuchPoker)

USOP (U Series of Poker) festivals that weren't run on Grand Loyal's tracker come from SoMuchPoker's event calendar
(`tools/smp.js`, for a `docs/series.js` entry with `source: { smp: '<festival path>' }`): Taiwan 2023, Vietnam 2023,
Hanoi 2023, Da Nang 2024, Hai Phong September 2024, Hai Phong Grand Finale 2024 and Japan Osaka 2025. Each event page's
embedded data gives its entries, prize pool, buy-in and winner's prize; its `/payouts` page every paid place with the
player and country, and the prize in USD where SoMuchPoker has the amounts.

- Hai Phong 2024 (both) has every prize (in USD; buy-ins converted at the day's rate). Osaka 2025 and the others have
  every place but only the winner's prize; Taiwan 2023 no amounts at all. Events with no payouts there are left out,
  and players' bullets are a minimum (one per cash).
- Not on SoMuchPoker with results: USOP Da Nang 2023, Taiwan 2024, 2021, and the U Series Championship (USC) Japan
  2026 stops (schedules only).
- USOP Vietnam May and August 2026 (Ha Long Bay, on Grand Loyal's tracker) get SoMuchPoker's payouts put in
  (`source.smpPayouts`, `mergeInto()` in `tools/smp.js`): 1,248 and 995 paid places instead of the tracker's 405 and
  286. Places and players are SoMuchPoker's (the tracker's leaderboard ranks follow the chips when play stopped, and
  had 1st and 2nd swapped in about half the events), named as the tracker's entrant when it's the same person
  ("Dinh Hai Le" = "Le Dinh Hai"; 93-96% are). Amounts are the tracker's VND where it has the place, else
  SoMuchPoker's USD at the rate the two imply for first prizes (26,371 and 26,110 VND/USD). Payouts now add up to
  the prize pool in 76 of 80 and 56 of 59 events.
- The same for GLPC IV and V (SoMuchPoker's GLPC tour): 353 -> 976 paid places for IV (payouts match the pool in 46
  of 47 events); V gains the 24 events Grand Loyal's tracker doesn't have (11 -> 35). GLPC VI gets it when its poller
  archives it (SoMuchPoker being down, or without results yet, leaves Grand Loyal's own payouts; the merge only warns).
  GLPC III isn't on SoMuchPoker: its results stay Grand Loyal's top places.

## Triton N. Cyprus 2026 (15–30 Nov 2026)

`docs/triton/` (page at `https://<owner>.github.io/<repo>/triton/`), built on the public GraphQL API the
Triton Poker+ app loads (`prod-public-serverless.triton-poker.com/graphql`, no login).

- Engine: `docs/triton/triton.js`, record on the `triton-data` branch (series `triton-n-cyprus-2026`), saved every 2 minutes.
- The API lists every participant with their buy-in transactions (bullets), alive flag, latest bust time and live chips,
  and payouts name the player in each place, so bullets, buy-ins and prizes are exact. Re-entry times come from polling.
- The API only allows pages on tritonpoker.plus (CORS), so the page cannot poll it. It reads the poller's saves instead:
  it asks GitHub's API for the branch's latest commit (an unchanged answer costs nothing against the rate limit) and
  fetches `state.json` at that commit, which avoids the raw host's 5-minute cache.
- Buy-ins use the amount in each event's name (the schedule's `buyIn` field is stale for some upcoming events).

## Home page and layout

`docs/index.html` is the home page: one banner per tracked series under *Running now*, *Coming up* or *Past*
(by the series dates in its venue's time zone), with live counts from each tracker's `meta.json` (events running and
finished, players, bullets, prizes paid). The banners come from `docs/series.js`; each page's title links home.

## Past Triton festivals and all-time view

`node tools/triton-archive.js` saves every finished Triton tournament festival (2018 onwards) to
`docs/triton/archive/<festival id>.json` plus `index.json`. Run it again only to add a festival that has since ended
(`--only <id>`, `--force` to refetch; `--merge` only rebuilds `all.json`). The Triton page shows one with `?f=<festival id>`
and all of them together, plus the festivals in `docs/series.js` not archived yet, with `?view=all`; the home page lists
them under Past.

The tool also writes `archive/all.json`: every archived festival already merged, as one file (~470 KB gzipped, versus 28 files),
with the exchange rates for those dates included. Profile ids are shortened to 8 characters in one name → id table.
The all-time view loads it in one request, with no merging or rate requests in the browser, and is ready in about a second.

- Every festival has players, entries, named payouts and each player's final bust time. Bullets per player come from the
  participants' `noOfEntries` field (served by the API though the Triton+ app doesn't request it; the same numbers
  MTTDB.com publishes) and, from Sep 2026, buy-in transactions. They add up to the official entries in most events since
  2019; Triton One multi-flight events list only part of the field and 2018–19 are incomplete, so those show a minimum (≥).
  A count summing far above the entries (one event) is ignored.
- Buy-ins are what players pay, read from the event name or the listed amount when that is the name's amount plus fee
  (Triton's own transaction amounts leave the fee out).

## Currency switch

Every tracker has a currency menu at the top (remembered across the trackers). `docs/fx.js` converts each amount at the
rate of its own date — a buy-in at the event's start, a prize at its finish — using ECB rates via Frankfurter (history back
to 1999) and, for TWD and VND, daily rates on jsDelivr (from March 2024; earlier dates use the first available day).
Rates are cached in the browser. The all-time Triton view always picks one currency (USD by default).

## Data checks (rules added after an audit)

- APT: re-entries are capped by the event's limit from its name (Freezeout = 1 bullet, "1 Re-Entry" = 2, "2 Re-Entry" = 3);
  a return past the limit is a seat move or glitch. Saved history is repaired the same way. "All bullets known" also counts
  an event whose bullets seen reach the official entries (e.g. a freezeout where every entrant was seen).
- GLPC: a return is a re-entry only if the entry count rose since that player's bust and an official rebuy is still unclaimed.
  "All bullets known" also counts events where every official rebuy is attached to a player.
- Triton: event start = the event's own start date (the day list sometimes holds only Day 2), the venue's time zone when
  Triton's is missing or wrong, never after the first bust. Pre-2020 bust times are a placeholder (21 Apr 2021) and are ignored.
- ITM % on players is per bullet (cashes / bullets); the panel also shows it per event.

## APT registration lists

Each APT event has an unlinked page, `/series/<series>/events/<id>/players`, listing everyone registered (name and
country, no entry counts). The poller reads it every 2 minutes while an event runs and once when it finishes (including
events that finished before tracking began), and adds every registered player never seen at a table with one bullet.
Later days list that day's players, so a Final Day player found in an earlier flight counts as carried over.
"All bullets known" on APT means the bullets counted (seen, re-entries seen, registered) add up to the official entries
within 2 or 1%; elsewhere unattributed re-entries make players' bullets a minimum. A finished multi-flight event's panel
shows every flight's players with bullets summed.

## All series (`docs/all/`)

Every player and event the trackers hold, across every series in `docs/series.js` and every Triton festival:

- **Players**: one row per person with bullets, buy-ins, prizes, net and ITM % summed across series, tags for the series they
  played, a summary (also split by series), and filters by organiser, year, finished events and all bullets known. The
  panel shows the person's totals, a table by series (each row opens the player in that series' tracker), a bankroll chart
  over every event, and every event they played.
- **Events**: every event of every series, newest first (or by buy-in, entries or prize pool); each opens in its own tracker.
- Each series is counted by its own engine (`players(state, { detail: true })` lists every player's events with bullets,
  buy-in and prize); the page converts the amounts to one currency at each date's rate.
- Series don't share player ids, so a person is matched by name in any word order, ignoring accents, hyphens and case
  ("Chen Kuan-Han" = "Kuan Han Chen"), and only when the countries agree or one is missing (`docs/people.js`). Same-name
  players from the same country are merged, and different spellings stay apart, unless `docs/people.json` says otherwise:
  - `"same": [["Chengxu Hu", "Cheng Xu Hu"], ["Daniel Smiljkovic"], ...]`: names that are one person, merged whatever their
    countries (one name alone: everyone under it, for one person whose flag differs between series).
  - `"apart": [{ "name": "Danny Tang", "people": [["triton"], ["apt"]] }]`: one name, several people, each with the series
    listed (an id from `docs/series.js`, a past APT series' slug, `triton`, or an organiser for all its series; series not
    listed go with the first person).

  `node tools/people.js` lists the likely cases, most prize money first: one name twice in one series, the same name with
  other countries, the same letters split differently (usually one person), and names a letter apart (often two people). It
  also lists fixes that no longer match anyone. Edit `docs/people.json`, push, and the page picks it up (no stamping).
- Within one APT series, the engine already treats as one player the spellings a registration list, the seating and the
  payouts give the same person ("Cheng Yu Chung" / "Cheng-Yu Chung", "Chen Rong" / "Rong Chen"): the same words with the family name
  moved or the whole name reversed, or the same letters split differently, with countries that don't disagree and never
  seated in one event together. It keeps the payout spelling. Before this, such a cash also counted an extra bullet.
- Tracker pages open a player or event from a link: `?player=<name>`, `?event=<event id>`.

## Past APT series

`node tools/apt-archive.js` saves every finished series listed on theasianpokertour.com/series (22 from Manila 2022 on)
to `docs/apt/archive/<series slug>.json` plus `index.json`. The APT page shows one with `apt/?f=<slug>`. The home page
lists them under Past, and the all-series page includes them. Run it again to add a series that has since ended (`--only <slug>`,
`--force` to refetch, `--repack` to rewrite the files without requests). For a series we watched live, archive its own record
instead, which has bust times and re-entries: `--series <id in docs/series.js> --from-state <state.json>` (the poller does this
by itself when a series ends). `fx.json` only grows: days already saved aren't asked for again.

- A finished series still serves every event's entries, buy-in and times, its payouts, and its registration list (everyone
  who registered, once each, with country). Each registered player counts one bullet per flight.
- Re-entries aren't published, so for series we didn't watch live a player's bullets and buy-ins are a minimum (≥).
  The exception is events whose registrations add up to the entries (freezeouts and other small fields), which count under
  "All bullets known". Prizes and places are exact.
- Players known only from a registration list are stored as `name|country` (`pack()` / `unpack()` in the engine), which keeps
  a series to roughly 30–100 KB gzipped.
- TWD and VND rates before March 2024 use the first day available (2 March 2024), so conversions of older Taipei and Vietnam
  series are approximate.
