<p align="center"><img src="public/mascot.png" alt="The sprintomatic mascot: a wind-up robot sprinting" width="280"></p>

# sprintomatic

sprintomatic is a memory and bookkeeping layer on top of **your** Azure DevOps
board. You use it from Claude Code, an AI chat that runs in your terminal.

The board stays the source of truth. Plans, states, estimates and parent links
are always read back from Azure DevOps. sprintomatic only keeps what the board
has no field for:

- **Why things happened.** Why a task got stuck, what you decided halfway
  through, where you stopped at the end of the day. This lives in a local file
  on your machine, not on the board.
- **Where the time went.** A clock starts when you open a work session on a task
  and stops when you close it. Nothing is written to the board until you say
  the task is done and agree the hours.
- **One way in to the board.** Every read and every change the AI makes goes
  through a named tool. So the chat, the dashboard and the board show the same
  thing.

A small dashboard in your browser shows the same picture as the chat.

## What it is, and what it is not

- **Single-user, local, no login. This is by design.** One person, one machine.
  There is no password and no account. The dashboard only listens on your own
  computer and refuses changes sent from other web pages.
- **Claude Code and Azure DevOps only, today.** Other AI tools and other boards
  (Jira, GitHub Issues and so on) are not built.
- **One Azure DevOps organization, project and team at a time.**
- **Not a team tool.** There is no shared view and no reports for anyone else.
- **Opinionated.** The plain-language voice of the AI and the rules about effort
  are the product, not settings you can turn off. Hours are estimated once on a
  task and burned down as you work. Work sessions attach to tasks, never to
  stories. The AI writes in short, plain sentences and will not let you drift
  away from the sprint. If that is not how you work, this tool will get in your
  way.

## What it was checked against

It works on my machine. That machine is:

- macOS
- Node 24 (`engines` in `package.json` asks for `>=24.0.0 <25.0.0`)
- An Azure DevOps project whose process has User Story and Task types, and a
  Blocked state on both
- Claude Code

Other setups may work, but nobody has tried them. Contributions are welcome.

## Install

You need Node 24 and access to an Azure DevOps project. There are two ways to
reach the board:

- **The Azure CLI.** Run `az login`, then
  `az devops configure --defaults organization=… project=…`. sprintomatic reads
  those defaults.
- **A personal access token.** No Azure CLI needed. See `docs/azure-access.md`.

Then, in the folder where you cloned this:

```sh
npm install
npm run setup   # asks a few questions and checks the connection
npm start       # the dashboard on http://localhost:7777
```

`npm run setup` asks how to reach the board, which board, and what your week
looks like (working days, hours in a day). It checks that it can reach the
board, reads your board's state names, and tells you if there is no Blocked
state for tasks. It is safe to run again. You can change all of it later in the
Settings panel of the dashboard.

On a Mac, a token goes into the Keychain. On other systems it is kept in plain
text in the local settings file.

### Connect Claude Code

Run this once. Replace the path with the folder where you cloned the repo
(`npm run setup` prints this line with the right path filled in):

```sh
claude mcp add -s user sprintomatic -- npm --prefix /path/to/sprintomatic run mcp --silent
```

To remove it later: `claude mcp remove sprintomatic`.

### Optional: your calendar

sprintomatic can read your Outlook calendar to work out your real desk time
after meetings. See `docs/setup/outlook-calendar.md`.

## Where your data lives

Everything sprintomatic keeps is in a folder called `.sprintomatic` in your
home folder:

- `data.db` is a SQLite file. It holds work sessions and what happened in them,
  time entries, the AI's notes, and settings.
- `archive/` has one plain markdown file per task with its session history, so
  you can read it without the tool running.

## How it is built

- **The MCP server** (`mcp/server.ts`) is what Claude Code talks to. It is one
  file with the tools and the instruction text the AI reads. Tool list:
  `mcp/README.md`.
- **The dashboard** is a React app in `src/`. `server/serve.ts` serves it and
  its data API on port 7777.
- **The shared backend** is in `server/`. Both the MCP server and the dashboard
  call the same code, so there is one set of rules.
- **The board** is only reached through `server/ado-client.ts`. It either runs
  the `az` command or calls the Azure DevOps REST API with your token.

Every setting, and where it is read from: `docs/configuration.md`.

## Useful commands

- `npm start` builds the screens and starts the dashboard on port 7777.
- `npm run dev` starts a live-reloading copy of the screens on port 5173. It
  gets its data from the dashboard on 7777, so keep that running too.
- `npm run setup` runs the guided setup again.
- `npm test` runs the tests (Vitest).
- `npm run typecheck` checks the types. Do not run bare `tsc`. The root
  `tsconfig.json` only points at the three real configs, so bare `tsc` checks
  nothing and always passes.

## Rough edges

- **The dashboard only starts by itself through a chat.** When Claude Code
  greets you, sprintomatic checks the dashboard is up and starts it if not.
  Without a chat, for example right after a restart, run `npm start` yourself.
- **The dashboard does not reload itself after a code change.** Stop it
  (`dashboard_stop` from a chat, or Ctrl-C) and start it again.
- **A settings change reaches the AI in new chats.** The AI's instruction text
  is written once when a chat starts. Open a new chat, or reload sprintomatic
  in the open one, to pick up a change to your week.

## License

MIT.
