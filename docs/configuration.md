# Configuration

Every setting sprintomatic reads, in one list.

## The one rule

Each value is looked up in this order, and the first one found wins:

1. **Environment variable** (`SH_...`) — set it in the MCP server's `env` block
   or in the shell that starts the dashboard.
2. **Setting** — a row in the `settings` table of `~/.sprintomatic/data.db`.
3. **Built-in default.**

A blank value counts as not set. A value that makes no sense (a 30-hour
workday, an end hour before the start hour) is ignored and the default is
used instead.

There are three ways to change a setting:

- **The Settings panel** in the dashboard (the Settings button at the bottom
  of the left rail). A value forced by an environment variable shows there as
  locked, with the variable's name, so an edit never quietly does nothing.
- **`npm run setup`** — asks the questions one at a time, checks the
  connection, reads your board's state names, and prints the line that adds
  sprintomatic to Claude Code. Safe to run again.
- **By hand**, for anything the two above don't cover:

```sh
sqlite3 ~/.sprintomatic/data.db \
  "INSERT INTO settings (key, value) VALUES ('working_days', '1,2,3,4,5')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value"
```

The dashboard picks up a change on its next refresh. The AI's instruction
text is written once when a chat starts, so a change to your week shows up
there in chats opened after it (or after you reload sprintomatic in an open
chat). A board setting saved in the Settings panel takes effect in the
dashboard right away.

## Your week

| What | Env variable | Setting | Default |
|---|---|---|---|
| Working days, as weekday numbers (0 = Sunday … 6 = Saturday), comma list | `SH_WORKING_DAYS` | `working_days` | `1,2,3,4,5` (Mon-Fri) |
| Hours in a workday. Also what one story point means | `SH_WORKDAY_HOURS` | `workday_hours` | `9` |
| Hour the workday starts (meetings before it don't count) | `SH_WORKDAY_START_HOUR` | `workday_start_hour` | `8` |
| Hour the workday ends (meetings after it don't count) | `SH_WORKDAY_END_HOUR` | `workday_end_hour` | `18` |
| How much a tentative meeting counts, 0 to 1 | `SH_TENTATIVE_WEIGHT` | `tentative_weight` | `0` (ignored) |

Code: `server/user-config.ts`.

## Azure DevOps

| What | Env variable | Setting | Default |
|---|---|---|---|
| How to reach the board: `cli` (the `az` command) or `api` (a token) | `SH_ADO_ACCESS_MODE` | `ado_access_mode` | `cli` |
| Organization URL, e.g. `https://dev.azure.com/your-org` | `SH_ADO_ORG` | `ado_org` | `cli` mode: `az devops configure` default |
| Project | `SH_ADO_PROJECT` | `ado_project` | `cli` mode: `az devops configure` default |
| Team you plan with | `SH_ADO_TEAM` | `ado_team` | `cli` mode: the only team, if there is just one |
| Your identity (new items are assigned to it) | `SH_ADO_USER` | `ado_user` | `cli` mode: the signed-in `az` account |
| Personal access token (`api` mode only, a secret) | `SH_ADO_PAT` | Mac Keychain, else `ado_pat` | — |

In `api` mode org, project, team and user must be set — there is no `az` to
ask. Details: `docs/azure-access.md`.

The token is the one secret. On a Mac, a token saved through Settings or
`npm run setup` goes in the Keychain (service `sprintomatic`, account
`ado_pat`) and not in the settings file. Elsewhere it falls back to the
`ado_pat` setting in plain text — the Settings panel says which one it is,
and offers to move an old plain-text token into the Keychain.
`SH_KEYCHAIN=off` turns the Keychain off (the tests use it).

## Other

| What | Env variable | Setting | Default |
|---|---|---|---|
| Most work sessions open at the same time | `SH_MAX_PARALLEL_SESSIONS` | `max_parallel_sessions` | `4` |
| Dashboard port | `SH_PORT` | — | `7777` |

## Set through the tool, not by hand

These are settings too, but sprintomatic writes them itself. You set them by
asking in a chat or through the dashboard:

- **Outlook calendar link** (`calendar_ics_url`) — ask the AI, which uses
  `calendar_set_url`. See `docs/setup/outlook-calendar.md`.
- **Meeting times** for Daily, Planning, Demo and so on (`ceremony_schedule`)
  — the dashboard.
- **Days off** (`days_off`) — the AI asks when it sees all-day entries in your
  calendar, or you tell it.
- **Board state names** (`state_waiting`, `state_going`, `state_blocked`,
  `state_done`) — read from the board by `npm run setup` or the Settings
  panel's "Check the connection". Without that, learned the first time an
  item is moved, by trying the usual names and keeping the one the board
  accepts.
