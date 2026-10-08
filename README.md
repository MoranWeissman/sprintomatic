<p align="center"><img src="public/mascot.png" alt="The sprintomatic mascot: a wind-up robot sprinting" width="260"></p>

<h1 align="center">sprintomatic</h1>

<p align="center">
  <b>Run your sprint from a chat.</b><br>
  An AI helper for Azure DevOps that keeps your board up to date,<br>
  tracks your time, and remembers what you did and why.
</p>

---

## What it does

You work in [Claude Code](https://claude.com/claude-code) like you always do.
sprintomatic sits between the chat and your Azure DevOps board.

- **It keeps the board up to date for you.** Say you're starting a task, and it
  moves to active on the board. Say you're stuck waiting on someone, and it
  moves to blocked, with the reason written down.
- **It tracks your time.** A clock runs while you work on a task. When you're
  done, it asks you to agree the hours before anything goes on the board.
- **It remembers.** Why a task got stuck, what you decided halfway, where you
  stopped yesterday. Tomorrow's chat picks up where today's ended.
- **It shows your day on one screen.** A small dashboard in your browser shows
  what you're working on, what's stuck, and how many hours you have left this
  sprint. It also helps with the daily meeting, planning and the retro.

**The board always wins.** sprintomatic never keeps its own copy of your plans
or task states. It reads them from Azure DevOps every time. It only stores what
the board has no place for: your notes and your time.

## Is it for you?

It probably is if:

- you work alone on your own tasks in **Azure DevOps** (User Stories and Tasks)
- you use **Claude Code**
- you want the AI to keep you on track, not just do what you say

It's probably not if you need a team tool, Jira or GitHub Issues, or a
different AI chat. None of those are built.

Know this before you start:

- **It's for one person on one computer.** There's no login and no account. The
  dashboard only works on your own machine.
- **It has opinions.** The AI writes short, plain sentences. Hours are estimated
  once and counted down as you work. Time goes on tasks, never on stories. If
  that's not how you work, this tool will get in your way.
- **It's tested on one setup:** macOS, Node 24, Claude Code, and an Azure DevOps
  project with User Story and Task types and a Blocked state on both. Other
  setups may work, but nobody has tried them yet.

## Get started

You need **Node 24** and access to an Azure DevOps project.

**1. Choose how to reach your board.** Either sign in with the Azure CLI
(`az login`), or make a personal access token (see
[docs/azure-access.md](docs/azure-access.md)).

**2. Install and set it up.** In the folder where you cloned this repo:

```sh
npm install
npm run setup
```

Setup asks which board you use and what your work week looks like. Then it
checks that it can reach the board. You can run it again any time, and you can
change everything later in the dashboard's Settings.

**3. Connect it to Claude Code.** Setup prints this line with your folder
filled in. Run it once:

```sh
claude mcp add -s user sprintomatic -- npm --prefix /path/to/sprintomatic run mcp --silent
```

**4. Say hi.** Open Claude Code and say good morning. sprintomatic starts the
dashboard at http://localhost:7777 and tells you where your sprint stands.

**Optional:** it can read your Outlook calendar, so meetings come out of your
free hours. See [docs/setup/outlook-calendar.md](docs/setup/outlook-calendar.md).

## Good to know

- **Your data stays on your computer.** Everything lives in a `.sprintomatic`
  folder in your home folder. There's one database file, plus a plain text file
  per task with its history, so you can read it without the tool.
- **On a Mac, your token goes into the Keychain.** On other systems it's kept as
  plain text in the local settings file.
- **The dashboard starts by itself only when you open a chat.** After a computer
  restart, either open a chat or run `npm start`.
- **Changed your settings?** Open a new chat to see the change. A chat that's
  already open still uses the old settings.

## For developers

- `mcp/server.ts` is what Claude Code talks to: the tools and the instructions
  the AI reads. The list of tools is in [mcp/README.md](mcp/README.md).
- `src/` is the dashboard (React). `server/serve.ts` serves it and its data on
  port 7777.
- `server/` is the shared code. The chat and the dashboard use the same rules.
- `server/ado-client.ts` is the only place that talks to Azure DevOps.
- Every setting is listed in [docs/configuration.md](docs/configuration.md).

Commands:

| Command | What it does |
| --- | --- |
| `npm start` | Builds and starts the dashboard on port 7777 |
| `npm run dev` | Live-reloading screens on port 5173 (keep `npm start` running too) |
| `npm run setup` | Runs the guided setup again |
| `npm test` | Runs the tests |
| `npm run typecheck` | Checks the types. Don't run bare `tsc`: it checks nothing and always passes |

Contributions are welcome.

## License

MIT
