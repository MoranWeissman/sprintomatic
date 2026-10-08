# sprintomatic MCP server

Lets Claude Code (or any MCP client) read sprintomatic data and drive edits and
session logging — the same backend the Vite dashboard uses. Time is tracked
silently by the session lifecycle; there are no manual timer tools.

The whole server is one file, `mcp/server.ts`. It talks over standard input and
output, and it carries a long block of instructions that tell the assistant how
to behave — when to greet, when to log, what never to do.

## Register with Claude Code

From any directory, run this once, replacing the path with wherever you cloned
the repo:

```sh
claude mcp add sprintomatic -- npm --prefix /path/to/sprintomatic run mcp --silent
```

If your shell is already sitting in the repo, `--prefix "$PWD"` does the same
job.

Then in any Claude Code session, the tools below are available.

To remove later: `claude mcp remove sprintomatic`.

## Tools

42 tools, grouped by what they are for.

### Getting oriented

| Tool | What it does |
|---|---|
| `orient` | The opening greeting. Where the user left off, sessions still open, what day of the sprint it is, how many helper notes are waiting. Call once when the user is reorienting — new chat, after a compact, or a "hi". |
| `sprint_snapshot` | The full current sprint: counts, what is in progress, live sessions. Heavier than `orient`. |
| `list_my_work_items` | Flat list for the sprint, with an optional filter for waiting / going / done. |
| `workitem_get` | One item by id — fields, parent, children, effort, url. |
| `capacity_check` | Real desk time for the sprint: working hours minus meetings from the calendar, against what the tasks are planned at. |
| `planning_gaps` | Every task in the sprint being planned that is missing an original estimate or remaining hours. |
| `story_match` | Ranks current-sprint stories against this chat's folder, git remote and recent commit subjects, so a chat can work out which story it belongs to. |
| `story_match_set` | Remembers a confirmed folder-to-story match so the next chat in that folder does not have to ask again. |

### Sessions and time

| Tool | What it does |
|---|---|
| `session_start` | Open a session on a task (never a story). Starts the silent clock and flips the task, and its parent story, to an active state on the board. |
| `session_log` | Record something inside a session: focus, progress, a decision, something stuck, or a plain note. Can burn down the remaining hours at the same time. |
| `session_waiting` | Mark the task as waiting for the user right before the assistant stops to ask a question, so it shows on the dashboard's "Needs you" card. |
| `session_end` | Close a session with a one-line summary. Pauses the clock. With `done: true` and the agreed hours, pushes the time to Azure DevOps and closes the task. |

### Changing something on the board

| Tool | What it does |
|---|---|
| `workitem_edit` | Change state, original estimate, remaining hours, story points, effort, tags or sprint. |
| `workitem_reparent` | Move an item under a different parent. |
| `workitem_change_type` | Flip an item between User Story and Bug. Only those two — tasks, features and epics are refused. |
| `workitem_block` | Mark an item blocked: the state, the tag and a written reason together. |
| `workitem_unblock` | Clear a block and record why it lifted. |
| `story_close` | Move a finished story or bug to the team's done state. Stories only — tasks close through `session_end`. |

### Creating and planning

| Tool | What it does |
|---|---|
| `sprint_check_in` | Before starting a stretch of work, check whether it is already in the sprint. Returns matches plus a next step to follow. |
| `task_create` | Create a task in the current sprint. Needs an hour estimate up front. |
| `story_create` | Create a user story. Needs story points and hours up front. |
| `bug_create` | Create a bug in the current sprint. |
| `feature_create` | Create a feature to group stories under. |
| `estimate_anchor` | Pull estimate-against-actual numbers from closed tasks, so a new estimate is anchored on history instead of a guess. |
| `preplan_set_goals` | Store the sprint goals on the private pre-plan page. Local only — never written to the board. |

### Discovery, design and sharing

| Tool | What it does |
|---|---|
| `workspace_feature_folder` | Start non-code work on a feature: makes its folder, records it as one being driven, and puts it on the board view. |
| `feature_kind_set` | Say which of the two ways a feature arrived — handed over, or made just to group stories that already exist. |
| `feature_unmanage` | Stop showing a feature on the board view. The folder on disk is untouched. |
| `design_sync` | Rewrite `design.md` from `design.json` so the two cannot drift, and report what is missing or wrong. |
| `design_push_stories` | Create every story drafted in the design, in one go. Refuses unless every part is agreed and the design review is recorded as done, and refuses a second push. |
| `feature_share` | Copy a feature's discovery, design and demo documents to the team's shared repository on a branch. |
| `skills_sync` | Fan the managed skills out from the one seed folder to every registered workspace, overwriting stale copies. |

### Helper notes

| Tool | What it does |
|---|---|
| `helper_notes_get` | Read the nudges already sitting in the user's notes space. Call before writing, so you do not repeat yourself. |
| `helper_note_add` | Drop one short plain-English nudge. Never touches Azure DevOps. |

### Setup and where things live

| Tool | What it does |
|---|---|
| `calendar_set_url` | Store the Outlook calendar feed used for the meeting hours. |
| `calendar_status` | Say whether a calendar is wired up. Reports the host only, never the full address. |
| `planning_home_set` | Set the folder used for sprint-wide planning chats. |
| `planning_home_status` | Read back the configured planning folder, and check whether a given folder qualifies. |
| `workspace_set` | Register a folder as a workspace for non-code work, and fill it once with the planning setup. |
| `workspace_decline` | Remember the user said no to a folder, so it is never offered again. |
| `workspace_status` | List registered workspaces, and decide whether the current folder is worth offering. |
| `repo_link_set` | Write `.sprintomatic/link.json` in a code repository, saying which feature or stories that repository serves. |

## Recommended flow at session start

1. Call `orient` first, and write a short greeting from what it returns.
2. Call `story_match` with this chat's folder to see which story this chat is
   probably about. Confirm by title, never by number.
3. Ask what the user wants to pick up.
4. Call `sprint_check_in` with their own words, then follow its `nextStep`:
   - a single match — confirm it, then `session_start` on a task under it;
   - several — read the titles out, ask which;
   - none — ask whether it is a quick one-off or a real new story, create it,
     then start on the new id.
5. As you work, call `session_log` for what got done, what got decided and what
   got stuck. The clock runs itself while the session is open.
6. When wrapping up, ask: done, or just stopping for now?
   - stopping — `session_end` with a summary. The clock pauses, the board is not
     touched;
   - done — confirm the hours first, then `session_end` with `done: true` and
     the agreed hours. That pushes the time and closes the task.

Throughout, keep the helper notes current: drop the occasional nudge with
`helper_note_add` when you spot something worth attention — a low estimate, a
task that has gone quiet, a clear day for deep work. Read `helper_notes_get`
first so you do not repeat yourself. These never touch Azure DevOps.

## Notes

- Single user, local only. No login. The MCP server runs as the same operating
  system user as the `az login` it borrows.
- Writes share the same SQLite file (`~/.sprintomatic/data.db`) and the same
  Azure DevOps access as the dashboard, so a change shows up in both places.
- Session events surface live on the dashboard — the activity feed and the live
  markers.
- Every board read and write is meant to go through a tool here. If something is
  missing, the assistant is told to stop and say so rather than reach for a raw
  `az` command around the gap.
- The MCP server and the dashboard are two separate processes, each with its own
  cache. They coordinate through a marker in the settings table, not in memory.
- Editing `mcp/server.ts` needs the MCP server reloaded in each open chat before
  the change takes effect.
