---
name: design
description: Use when running the DESIGN phase on a feature in this workspace — turning a finished discovery into agreed stories with estimates, a working plan, diagrams, and a push to the board. Comes AFTER discovery, never replaces it.
---

# Design (this workspace)

Design turns a finished discovery into work the team can pick up: stories
with estimates, a build order, and pictures. It ends with ONE push that
creates the stories on the board — nothing lands there before it.

## Where it lives

`design/design.json` in the feature's folder (create `design/` if absent).
Pictures are SVG files in `design/diagrams/`.

**`design.json` is the only file you edit. `design.md` is generated.**
After EVERY change to `design.json`, call
`mcp__sprintomatic__design_sync`. It rewrites `design.md` from the JSON,
so the two can never say different things, and it tells you what is
wrong: a picture named in the design but missing from `design/diagrams/`,
a colour used as a state, a story with no hours, an agreed mark left on a
story that was retitled, and any entry the reader had to skip because an
edit mangled its shape. It writes nothing when the JSON won't parse.

Never hand-edit `design.md`. The change is lost on the next sync, and the
file says so at the top.

Editing `design.json` by search-and-replace is the one place a mistake is
SILENT — a replace that matches nothing does not fail. `design_sync` is
what turns that silence into a message, so run it every time, not at the
end.
Meeting summaries (the design review too) go in `design/meetings/` — same
rules as discovery meetings: summaries ONLY, raw material in
`design/meetings/sources/`, never rewrite an existing meeting file.

## Start from the discovery

Read `discovery.json` first. It feeds design:

- `option` items and the tech lead's lane become entries in `decisions`.
- Risks and `dep` items must show up in story estimates: a story touching
  one gets more room, and its `why` line names it.

## The EXACT file shape — write these keys, no others

```json
{
  "note": "",
  "approach": { "lines": ["plain line: how we'll build it"], "diagram": "architecture.svg" },
  "outOfScope": ["what we deliberately leave out of this design, and one plain reason"],
  "flows": [ { "name": "Deploy flow", "steps": ["step 1", "step 2"], "diagram": "" } ],
  "stories": [
    { "title": "Board-ready story title", "covers": "what this story delivers", "estimateHours": 8,
      "why": "why this number — name the discovery risk or waits-on it touches",
      "boardDescription": "plain board text + Given/When/Then lines (optional)" }
  ],
  "plan": [ { "step": "what gets built at this step", "stories": ["Board-ready story title"], "note": "" } ],
  "decisions": [ { "question": "the open choice", "choice": "", "decidedInMeeting": "" } ],
  "review": { "status": "none", "date": "" },
  "pushed": { "at": "", "storyIds": [] },
  "agreed": ["approach", "outOfScope", "flows", "plan", "decisions", "story:Board-ready story title"]
}
```

- `note` is a free line at the top of the rendered design — "reworked
  2026-08-04, the earlier yes-marks are off until re-agreed". Not a part
  to agree. Leave it `""` unless the next reader really needs it.
- `review.status` is `none` / `scheduled` / `done` — set `done` only after the
  review meeting's summary file exists in `design/meetings/`.
- NEVER write `pushed` yourself — the push tool owns it.
- NEVER write a key into `agreed` without USER's explicit yes on that part.
- Each entry in `approach.lines` (and each flow step) is ONE idea in 1–2
  short sentences — never a paragraph. Ten short lines beat three long
  ones; the dashboard shows each line as its own row.

## Agree per part — never hand USER a finished wall

Build ONE PART at a time: approach → the "not in this design" list →
flows → each story (one by one — every story gets its own yes and its own
`story:<title>` key) → plan → decisions.
After drafting each part: explain it in simple, non-academic English
(simplify the WORDING, never the content), ask for USER's take, wait, and
only on a yes add its key to `agreed`. If an agreed part changes later,
remove its key and re-walk it. Retitling a story drops its old mark.

## Estimates must show their homework

Propose hours per story and say why in the `why` field, in plain words. A
story touching a discovery `risk` or `dep` MUST name it there and gets more
room. Before proposing, use the estimate history tool
(`mcp__sprintomatic__estimate_anchor`) so numbers anchor to USER's real
history, not gut. Every story needs real hours before the push — the push
refuses stories with no hours.

## Diagrams — made the draw.io way

Diagrams are CODE. Never draw by hand in the draw.io app — write the
`.drawio` XML file into `design/diagrams/` and work it like this:

1. **Write the XML** (`<name>.drawio`). The full XML rules, shape styles,
   and layout tips live in a drawio skill, if you have one installed
   (for example `~/.claude/skills/drawio-skill/`) — read its `SKILL.md`
   when you need shape names, edge rules, or layout help. A worked example
   in this house's style would sit at a path like
   `100001-add-dark-mode-to-settings/design/diagrams/flow-1-switch-reaches-page.drawio`.
2. **Lint it:**
   `python3 <drawio-skill>/scripts/validate.py <name>.drawio`
   — catches dangling arrows, duplicate ids, overlapping boxes.
3. **Export a preview:**
   `drawio -x -f png --width 2000 -o <name>-preview.png <name>.drawio`
   (NO `-e` on previews — an `-e` PNG breaks image reading.)
4. **LOOK at the preview yourself.** Fix overlapping boxes, cut-off
   labels, arrows that touch nothing. Re-export, look again (max ~2
   fix rounds before showing USER).
5. **Show USER the preview** and iterate until USER approves.
6. **After the yes, export the final picture:**
   `drawio -x -f svg -e --theme light --embed-svg-fonts false -o <name>.svg <name>.drawio`
   — `-e` embeds the source so the SVG stays openable and editable in
   draw.io later. **`--embed-svg-fonts false` is not optional.** Without it
   draw.io turns every label into a picture of text: one real drawing went
   from 42 KB to 1084 KB, with 18 bitmap labels and one real word of text.
   Bitmap labels go blurry the moment someone zooms the picture in front of
   a room. Keep the drawing on a common font (Helvetica or Arial) so it
   still looks right on any machine.
7. **Keep BOTH files** (`<name>.drawio` + `<name>.svg`) plus the preview.
   Reference the **`.svg`** name in `design.json`'s `diagram` fields —
   that's the file the dashboard shows. GitHub also shows `.svg` files as
   pictures but shows `.drawio` files as raw text, so the SVG export is
   the one every other place displays.

If the `drawio` command is missing (install: `brew install --cask drawio`),
fall back to a hand-written plain SVG: root `<svg>` tag with a `viewBox`
and NO width/height attributes, every text fitting inside its box with
room to spare.

Either way: one picture for the architecture, one per flow that earns it.
Calm colors — match the diagrams already in the feature's folder. And the
plain-English rule applies INSIDE the picture too: box labels and arrow
labels in simple everyday words, no report-heading style.

**Prefer draw.io over hand-written SVG.** Making one box taller in a
hand-written SVG meant writing a script to shift every element below it
down by 52 pixels, then re-checking every arrow endpoint. In draw.io it
is a minute. Keep hand-written SVG only for a drawing that is finished
and stable.

## How a drawing must behave

Every one of these came back as a correction during a real design week.

1. **Text spilling out of its box is the most common mistake by far.** It
   happened in almost every round, and it was found ONLY by looking at a
   rendered picture. After every single change: export the preview and
   look at it. Not "it should be fine".
2. **Boxes fit their text, and text is short enough to fit.** When a line
   does not fit, the two allowed fixes are: make the box wider or taller,
   or rebalance where the line breaks. Shrinking the font is not one of
   them. A box holds 2-3 short lines USER can talk from — never a
   sentence he would read aloud.
3. **An arrow must never cross a box.** If a note can only reach its
   target by cutting through something else, the note does not need a
   line at all.
4. **Never hang a side note off a decision diamond.** USER's words: "if
   tests passed then all good, why u have to the side 'the project
   settings'? looks like a condiution." A dashed line out of a diamond
   reads as a third branch, even dashed, even when the note is obviously
   a note. A decision shape has exactly its real branches and nothing
   else; side notes sit in a free corner with NO line attached. The
   general rule: in a flow chart a line means flow, so anything that is
   not flow must not be a line.
5. **A drawing's file name never changes.** Rework its whole content and
   title if you want — the file keeps its name. `design.json` points at
   drawings by file name, so a rename quietly breaks the slideshow.

## The review presents as a funnel, not a pile of parts

A design review never throws the parts in the reader's face. The order —
on the dashboard, in the walkthrough, and when YOU walk the parts in
chat — is always:

1. **What this is about** — the need it solves. This text comes from the
   discovery's `problem`; never rewrite it, the dashboard pulls it in.
2. **The big picture** — the architecture diagram, explained in a few
   plain words BEFORE any part is discussed.
3. **What we're not doing** — the `outOfScope` list, so scope is framed
   before details.
4. **The parts** — approach points, then each flow (a flow chart plus key
   points), then stories, plan, decisions.

`outOfScope` is a real part: non-empty means it needs USER's yes and its
`agreed` key, like everything else.

## The order of endings — three doors

1. Every part agreed (the file's `agreed` covers everything present).
2. The design review: when USER says it happened, write the meeting summary
   in `design/meetings/`, set `review.status: "done"`, and fill
   `choice`/`decidedInMeeting` on any decision the meeting settled.
3. The push: only when USER says push, call
   `mcp__sprintomatic__design_push_stories`. Echo the created stories'
   `displayName` strings verbatim. The board never sees drafts before this.
   The new stories land in the CURRENT sprint — if they belong to a later
   sprint, tell USER so he can move them on the board. The push tool only
   sees the ACTIVE feature — make sure this feature is the one your session
   is on.

The design story on the board will not close until all three doors are
passed, in that order (the gate reads the ACTIVE feature's design — stay
on this feature when closing).

## How to write — hard rules, not style tips

These rules shape every design in every workspace. The dashboard is built
around them, so breaking them breaks the page.

1. **First sentence stands alone.** Every decision `choice` and every
   story `covers` MUST open with one short sentence that works alone as
   the answer ("On the server." / "It can not happen." / "One switch, and
   the light look stays the default."). The rest of the text comes after it. The
   dashboard shows ONLY that first sentence when the item is folded — a
   first sentence that leans on the rest reads as broken on screen.
2. **Very simple, plain, non-academic English.** Short sentences. No
   idioms, no fancy words, no labels that sound like report headings.
   Say it as it is. USER is not a native English speaker and reads these
   on screen — if you would not say a sentence out loud to a friend,
   rewrite it.
3. **The approach is a short list, not a text.** Each `approach.lines`
   entry is one idea, one or two short sentences, readable in one glance.
   Details do NOT go in the approach — they go in the decisions and the
   flows.
4. **The same rules apply inside diagrams.** Box labels and arrow labels:
   simple everyday words, short.
5. **Colours are never states.** Say **passed** and **failed** — never
   "turns green", "everything is green", "all green". This hides in the
   design files AND inside drawings; grep for it before the review.
6. **Never invent a short label that sounds like a report heading.** Call
   the thing by its plain name: "a lock that got stuck", not "The stale
   lock". "The settings table", not "The table — it remembers". A story
   title too: "Dark mode switch on settings page", not "From a click
   to a darker page".
7. **A decision with no answer stays open.** Write every option into the
   decision. Never quietly record one as chosen because the conversation
   moved on.
8. **`boardDescription` is what the board shows.** Optional per story.
   When present, `design_push_stories` writes it as the story's
   description INSTEAD of `covers`. Write it before the push, so nobody
   edits fourteen stories afterwards: first a short plain-English line on
   what the story delivers, then the acceptance criteria as Given / When /
   Then lines. No design-record shorthand ("PLACEHOLDER HOURS", "atomic
   pick") — the delivery manager reads this. `covers` stays the design
   record's own detail.

Words that never appear: deterministic (say "always clear, never a coin
flip"), serializes ("makes them run one at a time"), re-registers
("enters again at the back"), mirrors drift ("a copy goes stale"). Plus
the standing bans: slack (for spare hours), cleanup moves, pending
decisions, outstanding items, open threads, burndown, scope (as a noun),
velocity, throughput, WIP, in-flight items, work item, blockers.

Also: names before numbers — echo `displayName` strings verbatim. Every
line exactly right — a wrong line a reviewer trusts is worse than a
missing one.
