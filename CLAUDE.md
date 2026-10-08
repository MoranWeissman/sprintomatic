# sprintomatic — rules for this repo

## This repo is public. Every commit is public the moment it is pushed.

So nothing private goes into any file: not in code, tests, comments, docs or
the MCP instruction text.

1. **Say "the user", never a personal name.**
   - Good: `// The user's team counts 1 story point as 1 day.`
   - Bad: a real person's name in that sentence.
2. **Use made-up work item ids in tests and examples.** Never a real ticket
   number from a board. Use the `#100001`, `#100002`, … range, so a real id
   stands out when it slips in.
3. **No machine paths, no employer names.** No `/Users/<someone>/...` in code,
   tests or docs. Build paths from `homedir()` or a setting. Never name a real
   company, repo, internal system or project.
4. **No real work content.** Never copy a real task title, story text or
   meeting note from a board into the repo. Invent an example instead.

The maintainer's machine runs a privacy check (`npm run release-scan`) before
every commit and every push, from local git hooks. It reads a private word
list and every ticket id the local database has seen, both kept outside the
repo. If it stops a commit, fix the file. Never skip it with `--no-verify`.

Design notes and plans go in `docs/superpowers/`. That folder is git-ignored,
so it stays on the local machine.

## The typecheck command is `npm run typecheck`, never bare `tsc`

`tsc --noEmit` in this repo **checks zero files and exits 0.** The root
`tsconfig.json` is a solution file — `files: []` plus references to the three
real projects (browser code, the vite config, and `server/` + `mcp/`). A bare
`tsc` reads only that root file, matches no source, and reports success no
matter how broken the code is.

Only `npm run typecheck` (`tsc -b --noEmit`) checks anything. `npm run build`
uses the same build mode.

The three configs are split on purpose: the browser code needs DOM types and
the Node code must not have them. Collapsing them into one would mix the two
ambient type sets. So the split stays, and this note is the guard.
