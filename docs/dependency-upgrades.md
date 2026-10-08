# Dependency upgrades — where we stand and what to do

Written 2026-08-24. Everything here was checked against the installed tree and
the projects' own release notes on the day. Where a claim could not be checked,
it says so.

## The short version

`npm audit` says **11 findings, 7 of them high**. That number sounds worse than
it is. Three of the eleven can actually reach the person using this tool. The
other eight sit in code that this project never runs.

Better news: **nine of the eleven are already allowed to be fixed by the version
ranges in `package.json` today.** The lockfile is from 7 June and is holding old
copies in place. A plain refresh of the lockfile clears them without changing a
single major version. The two left over are `vite` itself and the `esbuild`
underneath it, and one move fixes both — `"vite": "^5.4.11"` cannot reach a
fixed version of either.

Recommended order:

1. Refresh the lockfile and take the two small bumps (`markdown-it`,
   `dompurify`). About half an hour. Clears nine of the eleven.
2. Vite 5 → **7** (not 8). Half a day. Clears the last one, and closes the
   dev server that currently answers any web page.
3. better-sqlite3 11 → 13. About an hour. No security reason — it stops the
   tool dying the next time Node updates.
4. React 18 → 19. Two or three hours, whenever there is a quiet week. Buys
   nothing today.

Not worth doing right now: Vite 8, TypeScript 7, markdown-it 15, node-ical 0.27.
Reasons at the bottom.

---

## 1. What the audit actually found

The audit output is at the end of this section in plain terms. Two things decide
whether a finding matters here:

- **Can it reach him?** This tool runs on one machine, for one person. It serves
  nothing to the public. A hole in a build tool that only ever reads this
  project's own files is not the same as a hole in code that touches the
  network or handles text from somewhere else.
- **Is it even loaded?** Several findings are in packages that ship inside the
  Model Context Protocol SDK but are never imported, because this project's MCP
  server talks over standard input and output, not HTTP.

### The three worth acting on

**`vite` — high — direct dependency.** Three advisories:
[GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) (path
traversal when the dev server serves `.map` files for optimized dependencies),
[GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) and
[GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3). The
last two are Windows-only, so they do not apply on a Mac. The first one does.
This is real because the dev server sits on port 7777 all day, in the same
browser that also has ordinary web pages open.

**`esbuild` 0.21.5 — moderate — pulled in by vite 5.**
[GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99):
"esbuild enables any website to send any requests to the development server and
read the response." Rated moderate, but in this setup it is arguably the most
reachable finding of the lot, for the same reason as above. `vite.config.ts`
already refuses *changing* requests that come from another web page (the
`refuseWritesFromOtherSites` guard, line 41). It does not refuse *reads*. So
another page in the same browser can currently ask `/api/dashboard` for the
sprint and read the answer. Fixed by moving off vite 5 — vite 5's range is
`esbuild: ^0.21.3`, which cannot reach a fixed version.

**`dompurify` 3.4.6 — moderate — direct dependency.** Eight advisories, the
newest being [GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7).
This one is worth taking seriously because DOMPurify is doing a real job here:
`src/components/WorkItemDrawer.tsx` line 283 runs it over HTML descriptions
pulled off the board, and that HTML was written by other people. Fixed by
`dompurify` 3.4.14, which the existing `^3.4.6` range already allows.

### One that is reachable but nobody is attacking

**`linkify-it` 5.0.1 — high — under `markdown-it`.**
[GHSA-v245-v573-v5vm](https://github.com/advisories/GHSA-v245-v573-v5vm): a slow
`mailto:` scan that can be made quadratic by crafted text. It is reachable —
`markdown-it` runs with `linkify: true` in both `Dashboard.tsx` (line 404) and
`WorkItemDrawer.tsx` (line 18). But the text it reads is the user's own board
and the assistant's own notes. The worst case is a browser tab that hangs on
text somebody deliberately wrote to hang it. Fix it anyway, because it is free:
`markdown-it` 14.3.0 depends on `linkify-it ^5.0.2`, and the existing
`^14.2.0` range already allows 14.3.0.

### The five that are noise here

**`hono`, `@hono/node-server`, `fast-uri`, `ip-address`, `body-parser`** — all
arrive under `@modelcontextprotocol/sdk`. They exist because the SDK also ships
an HTTP transport with OAuth. This project does not use it. Checked directly:
`mcp/server.ts` line 3663 constructs a `StdioServerTransport`, and grepping the
SDK's own `dist/esm/server/stdio.js` and `dist/esm/server/mcp.js` finds no
import of `express` or `hono` — those only appear under `server/express.js` and
`server/auth/**`, which nothing here loads. `ip-address` comes in one level
deeper still, under `express-rate-limit`. `fast-uri` comes under `ajv`, which the
SDK uses for JSON Schema; this project validates with `zod`. None of this code
runs. They will still show in `npm audit` until the SDK's own ranges move, which
they already have — `@modelcontextprotocol/sdk` 1.30.0 asks for `hono ^4.11.4`,
`ajv ^8.17.1` and `express-rate-limit ^8.2.1`, all of which resolve to fixed
versions.

**`postcss` and `nanoid`** — high, both under vite, both build-time only.
The postcss advisories
([GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp),
[GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)) need
someone to hand postcss a hostile stylesheet. There is exactly one stylesheet in
this project, `src/styles/dashboard.css`, hand-written here, and there is no
`postcss.config.*` at all. `nanoid`'s two advisories are infinite loops on a
negative or zero size, which postcss never passes. Both clear on a lockfile
refresh: vite 5 asks for `postcss ^8.4.43`, and the fixed 8.5.26 is inside that
range; postcss 8.5.26 asks for `nanoid ^3.3.17`, and the fixed 3.3.18 is inside
that.

### Count

Of 11 findings: **3 worth acting on** (vite, esbuild — one fix covers both —
and dompurify), **1 free to fix while you are there** (linkify-it), **7 noise
for this project**. Of the 7 rated high specifically: 2 matter, 5 do not.

---

## 2. Each upgrade, one at a time

### Vite 5.4.21 → 7 (recommended) or → 8

**Why this one is riskier here than in a normal app.** `vite.config.ts` is 752
lines and it is not a config file — it is the whole HTTP backend. Eleven routes
are registered on `server.middlewares` inside `configureServer`: `/api/health`,
`/api/dashboard`, `/api/workitem/`, `/api/schedule`, `/api/helper-note/`,
`/api/carry-forward`, `/api/planning/gaps`, `/api/planning/cockpit`,
`/api/preplan`, `/api/discovery`, plus the cross-site guard on `/api`. The
config also does `await import('./server/…')` in seventeen places to pull in the
backend modules, which means Vite's config loader is bundling most of `server/`
into the config. If Vite changes how it loads a config or orders its
middlewares, the dashboard stops answering. `npm test` will not notice — see
section 4.

**What actually changes.**

*5 → 6* ([migration guide](https://v6.vite.dev/guide/migration)): Node 21
dropped, 18 and 20 still fine. `resolve.conditions` gained real defaults. Sass
switched to its modern API. `postcss-load-config` went to v6. Nothing touching
`configureServer` or `server.middlewares`.

*6 → 7* ([migration guide](https://vite.dev/guide/migration)): **Node 20.19+ or
22.12+ required** — this machine is on Node 24.4.1, fine. Default build target
became `'baseline-widely-available'` (Chrome 107, Firefox 104, Safari 16.0).
Sass legacy API support removed — not used here. `transformIndexHtml` object
form must use `order`/`handler` — not used here. And the one line that matters:
"Some middlewares are now applied **before** the `configureServer` hook." That
does not break the guard in this project, because the guard and the eleven
routes are all registered in the same hook and keep their order relative to each
other. What runs earlier now is Vite's own CORS handling, which is the point —
that is the fix for the dev server answering other pages.

*7 → 8* ([migration guide](https://vite.dev/guide/migration),
[announcement](https://vite.dev/blog/announcing-vite8)): esbuild and Rollup are
replaced by Rolldown and Oxc. `build.rollupOptions` → `build.rolldownOptions`,
top-level `esbuild` → `oxc`, and so on. **None of those options are used in this
project's `vite.config.ts`** — grepped, zero hits for `rollupOptions`, `esbuild`,
`build:`, `optimizeDeps`, `sass`. Lightning CSS becomes a hard dependency and
the default CSS minifier. Build target moves again (Chrome 111, Safari 16.4).
Four plugin hooks removed, none used here.

**Does the middleware API survive to 8?** Yes, and this was checked on disk, not
from memory: vite 8.0.16 is already installed in this tree as a nested
dependency of vitest, and its `dist/node/index.d.ts` still exports
`type Connect` and still declares `middlewares: Connect.Server` on the dev
server. `ssrLoadModule` is also still there in 8.2; the Module Runner
replacement is listed as planned for a future major
([vite.dev/changes](https://vite.dev/changes/)).

**How much of this codebase is affected.** Almost none of it, on paper. The
config uses `defineConfig`, `plugins`, `server.port/strictPort/open`,
`configureServer`, `server.middlewares.use` and the `Connect` type. All of that
survives. The code change for a 5 → 7 hop is plausibly zero lines.

**The catch with 8, and why 7 is the recommendation.** `@vitejs/plugin-react` 6
peers on `vite: ^8.0.0` only, and it is a different plugin underneath — Babel is
gone, React Refresh runs through Oxc
([changelog](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md)).
On top of that, Lightning CSS replaces the CSS minifier for a hand-tuned
5,473-line dark stylesheet. There are no tests over any screen. That is two
places where the dashboard could quietly look different and nothing would tell
you. Vite 7 keeps `@vitejs/plugin-react` at 4.x (its peer range is
`^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`), keeps Rollup and PostCSS, and still
closes the dev-server hole.

**Honest cost of stopping at 7.** `npm audit` will still print one moderate line:
vite 7 asks for `esbuild ^0.27.0`, which resolves to 0.27.7, and
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) covers
0.27.3 through 0.28.0. That advisory is Windows-only, so on this machine it is
paperwork. You will also still be carrying two Vite majors on disk, because
vitest 4 bundles its own vite 8 (it is there right now). And the 7 → 8 hop still
has to happen one day.

**Time:** half a day for 5 → 7, done carefully. Most of it is not editing — it
is starting the dev server and clicking through every screen. A full day for
5 → 8, because of the plugin swap and the CSS minifier change.

**What could go wrong on the day, and how you would know.** The dev server
starts but `/api/dashboard` returns nothing, so the dashboard shows an empty
sprint — you would see it on the first page load. Or the pre-warm block at
`vite.config.ts` line 116 fails silently in its `catch`, and the first page load
is slow instead of broken. Or hot reload stops working, which is annoying rather
than dangerous. Check `curl localhost:7777/api/health` first — it is the one
route that reads nothing and opens no database.

### React 18.3.1 → 19.2.8

**What React 19 removed** ([upgrade guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)):
`propTypes`, `defaultProps` on function components, legacy context
(`contextTypes` / `getChildContext`), string refs, `React.createFactory`,
`ReactDOM.render`, `ReactDOM.hydrate`, `ReactDOM.unmountComponentAtNode`,
`findDOMNode`, and all of `react-dom/test-utils` except `act`, which moved into
`react`.

**How much of this codebase is affected: none of it.** Grepped all 14 `.tsx`
files and every `.ts` under `src/`:

- `propTypes`, `defaultProps`, `contextTypes`, `findDOMNode`, `ReactDOM.render`,
  `ReactDOM.hydrate`, `react-dom/test-utils`, string refs — zero hits each.
- `forwardRef` — zero hits.
- `src/main.tsx` already uses `createRoot` from `react-dom/client`.
- All four `useRef` calls already pass an argument (`null`, or `false`), so the
  new "useRef requires an argument" TypeScript rule costs nothing.
- Every `ref=` in the code is an object ref (`ref={rootRef}`), never an arrow
  callback, so the "ref callbacks may now return a cleanup function" change and
  its implicit-return type error cannot bite.
- Zero third-party React libraries. The only dependencies of the UI are
  `react`, `react-dom`, `markdown-it` and `dompurify`.

**What you would actually touch.** Bump `react`, `react-dom`, `@types/react` and
`@types/react-dom` together — `react-dom@19.2.8` peers on `react ^19.2.8`, so
they move as a pair. Then run the types codemod once:
`npx types-react-codemod@latest preset-19 ./src`. The one thing it will not do
for you is the global `JSX` namespace move (`JSX.Element` → `React.JSX.Element`);
`tsconfig.app.json` uses `"jsx": "react-jsx"`, so if any file references the bare
`JSX` namespace, `npm run typecheck` will tell you.

**Time:** two to three hours. Maybe twenty minutes of that is editing.

**What could go wrong.** Very little at build time. The risk is visual and
behavioural, and it is entirely on you to spot it, because there is not one test
that renders a component. Two specific things to watch: React 19 changed
`useId`'s prefix from `:r:` to `_r_`, so any CSS or code matching on generated
ids would break (there is none here, but check if you add some), and under
`StrictMode` — which `src/main.tsx` uses — `useMemo` and `useCallback` now reuse
the first pass's result during the dev double-render, which can surface a
memoization bug that was previously hidden.

### better-sqlite3 11.10.0 → 13.0.3

This is the one holding all the data, so it deserves the clearest answer: **the
API did not change.**

**v12.0.0** (2025-06-21,
[release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.0.0)):
the only breaking change is dropping Node 18 and old Electron. No API change.

**v13.0.0** (2026-07-21,
[release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)):
rewritten onto N-API via `node-addon-api ^8`. Requires Node >= 22 — this machine
is on 24.4.1. Adds `db.explain(sql)` and `stmt.toString()`. Nothing removed. A
diff of `docs/api.md` between v11.10.0 and v13.0.3 shows those two additions and
nothing else — `pragma`, `backup`, `prepare`, `exec`, `transaction` and the WAL
handling are unchanged. This project uses `prepare` (19 places), `exec` (15),
`pragma` (3: `journal_mode = WAL` and `foreign_keys = ON` in `server/db.ts`,
`wal_checkpoint(TRUNCATE)` in `server/backup.ts`) and `transaction` (2). All of
it survives.

**The native-module question, which is the real one.** better-sqlite3 is
compiled C++, so it has to match the Node it runs under. Right now this install
is **compiled from source, not a downloaded prebuilt binary** —
`node_modules/better-sqlite3/build/config.gypi` shows
`"node_module_version": 137` (Node 24), `"target_arch": "arm64"`, and a node-gyp
cache directory for 24.4.1. Version 11's install script is
`prebuild-install || node-gyp rebuild --release`, so the download must have
missed and the fallback compile ran. It worked — Xcode is installed and Python
3.14 is on the path — and the module loads today (checked: it opens an in-memory
database and reports SQLite 3.49.2).

That fallback is exactly the thing v13 removes. From v13 the prebuilt binaries
ship **inside the npm tarball** as export subpaths (`./darwin-arm64` among
them), and because it is N-API the same binary works across Node 22, 24, 25 and
26. Translated: today, the next time Node updates, the tool can break until
someone recompiles. After v13, it cannot. That is the whole reason to do this
upgrade — there is no security finding against better-sqlite3 at all.

**Time:** about an hour, nearly all of it checking.

**What could go wrong, and how you would know.** The install fails to find a
matching binary and tries to compile; if Xcode or Python were missing you would
see a wall of node-gyp errors during install. If the binary is wrong for the
running Node, the very first thing that touches the database throws
`NODE_MODULE_VERSION` mismatch — you would see it instantly, on `npm run mcp` or
the first dashboard load, not quietly later. There is no in-between state where
it half works. `@types/better-sqlite3` should go to 9.x at the same time.

**Not verified:** whether `.backup()` behaves differently at runtime — only the
documentation was compared, not the C++.

### Everything else `npm outdated` lists

- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 — a minor, inside the existing
  range, and it is what clears four of the noise findings. Take it with the
  lockfile refresh.
- `tsx` 4.22.3 → 4.23.12, `vitest` 4.1.8 → 4.1.11, `@types/node` 25.9.1 →
  25.9.5, `@types/markdown-it` 14.1.2 → 14.2.0 — all minors inside existing
  ranges. Take them with the refresh.
- `markdown-it` 14 → **15** — a major. It swaps `entities` 4 → 8, `argparse`
  2 → 3, `uc.micro` 2 → 3 and `linkify-it` 5 → 6. Skip it. 14.3.0 already fixes
  the advisory and this project only uses `render()`.
- `node-ical` 0.26.1 → 0.27.1 — a major that replaces its date handling with
  `rrule-temporal` and `temporal-polyfill`. This is the package that reads the
  calendar to work out real desk time. Repeating meetings are exactly what a
  date-library swap gets wrong, and the capacity numbers are the thing the
  greeting is built on. Skip until there is a reason.
- `typescript` 5.9.3 → **7.0.2** — TypeScript 7 is the native-Go rewrite. Do not
  go near it during a week that also touches Vite and React. Later, on its own.
- `@types/react` / `@types/react-dom` 19.x — these only move as part of the
  React 19 upgrade, not before it.

---

## 3. The recommended order, and why

**Do this first: refresh the lockfile.** The package.json ranges already allow
fixed versions for nine of the eleven findings. Take `markdown-it` to 14.3.0
(clears the linkify-it high), `dompurify` to 3.4.14 (clears the one that
sanitizes other people's HTML), the SDK to 1.30.0 (clears hono, fast-uri,
ip-address, body-parser), postcss to 8.5.26 and nanoid to 3.3.18 (clears two
more highs), tsx to 4.23.12 (clears one esbuild line). Half an hour. No major
versions move. This is by far the best return on effort here, and it is the
step most people skip because the audit output makes it look like majors are
required.

**Then Vite 5 → 7.** This is the only finding left that can actually reach him,
and it is the one that closes a dev server which currently answers any web page
in the same browser. Half a day. Stop at 7, not 8.

**Then better-sqlite3 11 → 13.** An hour, no security reason, but it turns the
"the tool broke after a Node update" failure from possible into impossible. Do
it as its own change, on a day when nothing else moved.

**Then React 18 → 19, whenever.** The codebase is unusually clean for it —
nothing React 19 removed is used anywhere. But it fixes no security finding and
adds no feature anyone here is waiting for. Its only value is not falling
further behind, and that is a real value, just not an urgent one.

**The honest cost of this order.** You end up on Vite 7 while the ecosystem
moves to 8, so you do the 7 → 8 hop later anyway, and you pay the plugin-react 6
and Lightning CSS risk then instead of now. `npm audit` will not read zero — one
Windows-only esbuild line survives, and it will keep nagging. And going one
version at a time means four separate evenings of checking rather than one big
one. That is the trade: four small chances to break the tool, each one
attributable, instead of one large chance that is not.

---

## 4. How to do this without losing the tool for a day

The thing to hold on to: **both halves of this project run straight from source
in this folder.** The dashboard runs from `vite.config.ts` under `npm run dev`,
and the MCP server runs from `mcp/server.ts` under `tsx`. Neither is built and
installed somewhere else. So a broken `node_modules` is not "the build failed" —
it is no dashboard and no assistant tools, until it is fixed. Plan around that.

**Before you start.**

- Take a database copy by hand. There is a daily one in
  `~/.sprintomatic/backups/` already, but take a fresh one anyway, because the
  daily copy is written when the tool opens and you are about to stop the tool.
- Copy `node_modules` aside. It is 186 MB and 562 packages. Copying the folder
  back is the fastest undo there is — much faster than re-resolving a lockfile
  and, in better-sqlite3's case, recompiling.
- Commit or stash whatever is in progress, so `git checkout package.json
  package-lock.json` is a clean escape.
- Do it at a time when not having the tool for an hour is fine. Not fifteen
  minutes before a daily.

**One upgrade per change. Never two.** With no tests over any screen, the only
way to know which change broke a screen is to have made one change.

**After each one, in this order.**

1. `npm run typecheck` — catches type-level breaks, which is where React 19's
   changes would land. Never bare `tsc`.
2. `npm test` — should stay at **53 files, 669 tests, all passing**, in about
   two seconds. That is the number to compare against; it was measured today.
3. `npm run build` — proves the browser bundle still compiles. Note what it does
   *not* prove: the built bundle has no backend behind it, because the API lives
   in the dev server config. It is a compile check, nothing more.
4. `npm run dev`, then `curl localhost:7777/api/health` — the one route that
   reads no database and warms nothing. If that answers, the middleware stack is
   alive.
5. `npm run mcp` — it should start and sit there waiting on standard input. If
   it exits, the assistant has no tools.

**Be honest about what `npm test` proves.** All 53 test files are pure logic:
48 under `server/`, 5 under `src/lib` and `src/components`, and **not one of
them renders a React component or starts the dev server**. `vitest.config.ts`
runs in the `node` environment. So a green test run tells you the sprint maths,
the session rules and the board logic are fine. It tells you nothing at all
about whether the dashboard draws, or whether the eleven API routes answer.
For a React or Vite upgrade, the tests are the easy half and the clicking is the
real check.

One useful thing to know: vitest 4 already carries its own copy of vite 8
(8.0.16, installed right now under `node_modules/vitest/node_modules/vite`).
So the fact that all 669 tests pass today is already a small piece of evidence
that this project's TypeScript survives vite 8's newer pipeline — for the
`server/` and `src/lib` files, at least. The `.tsx` files get no such assurance.

**"It still works" means clicking these.** In the browser on port 7777:

- The Daily page loads and shows the sprint, with hours on it.
- Open the drawer for a task (`src/components/WorkItemDrawer.tsx`). That one
  click exercises `markdown-it` and
  `dompurify` together on real board HTML — it is the check for both of those
  upgrades.
- The Plan page loads its list rows.
- The Discovery and Design page loads, including a diagram.
- The carry-forward banner appears if there is stranded work.
- Block and then unblock a task. That is a changing request, so it goes through
  the cross-site guard and then through to the board — the one round trip that
  proves the write path end to end.
- Collapse and expand the side panels, and reload. That checks the browser
  storage still reads.

In a chat: run `orient` and check the greeting comes back with real numbers in
it. That proves the MCP server, the database and the Azure DevOps connection are
all still talking.

**If it breaks.** Put back `package.json` and `package-lock.json` from git, drop
`node_modules`, restore the copy you set aside. If you did not set one aside,
`npm install` will rebuild it, and on the better-sqlite3 step that may include a
compile that takes a few minutes. That is the difference the copy buys.

**One thing that is easy to forget:** changing `vite.config.ts` needs the dev
server restarted before it takes effect. During a Vite upgrade you will be
restarting anyway, but it is the classic way to spend twenty minutes debugging a
change that was never loaded.
