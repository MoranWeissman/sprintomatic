---
name: discovery
description: Use when running a DISCOVERY on a feature in this workspace — a fast, high-level investigation that surfaces what's different from today and the risks it brings, sorts facts from options, and produces an end-to-end flow. NOT design, NOT implementation.
---

# Discovery (this workspace)

Discovery is the first work under a feature. It is **fast because it is focused**:
cover only the MAIN gaps, risks, mitigations, and dependencies. Every line still
has to be exactly right — speed comes from writing less, never from checking less.
It does NOT pick sides or weigh trade-offs — that is the later Design phase.

## The rules

- **One discovery per FEATURE**, not per story. (Discovering a single story is the
  rare exception — if asked, confirm out loud first: "Just this one story, not the
  whole feature? That's the special case — yes?")
- **2 working days, 3 max.** The 3rd is a deliberate choice, never the default.
- **High level only, main things only.** Topics are one-liners, never blocks of
  detail. A few context groups covering the MAIN areas — if an area has no real
  gap, risk, or dependency, it gets NO group at all; silence means "nothing
  important there". Before writing any line, ask: *would this line change a
  decision in design?* If no — leave it out.

## Check the feature before you start — what we don't accept as-is

The VERY FIRST step of a discovery, before any group is written: read the
feature's description and check two things:

1. **Too fat?** Does it bundle several unrelated things that should be
   separate features?
2. **Runbook?** Does it contain design instructions dressed as requirements —
   telling the team HOW to build instead of WHAT is needed?

Every finding becomes a one-liner in `pushback` ("what we don't accept
as-is"). Empty list = the feature is accepted as written. The list NEVER
blocks the discovery — it arms USER's talk with the product side, nothing
more. The dashboard shows it as its own card.

## Client-facing or backend? — decide early

Early in the discovery, decide: is this feature something an end-client (for
this team, usually a developer) USES DIRECTLY — a command they run, a screen
they see? Or is it behind-the-scenes plumbing nobody touches?

- Can't tell → ask USER one plain question: "who uses this directly?"
- Record the answer as a normal `fact` item in a fitting context group
  (e.g. "used directly by developers via the CLI").
- **Client-facing** → once the concept demo is built, nudge USER once:
  "want to show this to the end-clients before design starts?" Their feedback
  comes back as a discovery meeting (see the meetings section) and folds in
  the normal way.
- **Backend** → at most suggest a quick opinion from a developer or team
  lead. Optional, never a step, never a nag.

## What discovery must produce

Fill the discovery source file (`discovery.json` in this feature's folder) with:

1. **What we're solving** — 2–3 plain lines. The problem, not the solution.
2. **The end-to-end flow** — the plain story of how the feature works, step by step.
   This is what a demo would later show.
3. **Context groups** — split the feature into areas that make sense to a reviewer.
   In each group, one-liners tagged:
   - **diff** — where this makes the team work differently than today (only if a
     real difference exists).
   - **risk** — the cost or new skill that difference brings (e.g. "every page
     style needs a dark copy → twice the styling work"; "needs a colour token
     system → a new team skill").
   - **fact** — a given, not up for debate ("dark mode must follow the phone's
     system setting — the product asked for it, so it's a fact").
   - **option** — a real choice to make later.
   - **dep** — the work waits on someone or something outside the team.
   - **mitigation** — the answer to a risk, right under that risk.
   An item can be both a fact and an option (a fact that spawns a choice) — give it
   both tags.
4. **Lanes** — one line each: what's ours vs what's the tech lead's (parked, not
   designed here).
5. **Open questions** — one-liners for the platform-team talk.
6. **The "don't accept as-is" check** — the FIRST step: read the feature and
   list what we don't accept as written (too much bundled together, or design
   instructions dressed as requirements) in `pushback`. Empty = accepted.
7. **The agreement record** — every part above, explained to USER in plain
   words and marked in `agreed` after USER's yes. See "Agree per part".

## The EXACT file shape — write these keys, no others

`discovery.json` MUST use exactly these field names, or sprintomatic's gate
won't recognise it as finished. Do not rename or add top-level keys.

```json
{
  "problem": "2–3 plain sentences: what we're solving, not the solution.",
  "flow": ["step 1", "step 2", "step 3"],
  "groups": [
    {
      "name": "The area a reviewer would recognise",
      "items": [
        { "text": "what's different from today", "tags": ["diff"] },
        { "text": "the cost/new-skill it brings", "tags": ["risk"] },
        { "text": "a given, not up for debate", "tags": ["fact"] },
        { "text": "a real choice for later", "tags": ["option"] },
        { "text": "a fact that also forces a choice", "tags": ["fact", "option"] },
        { "text": "waits on someone/something outside the team", "tags": ["dep"] },
        { "text": "the answer to the risk above", "tags": ["mitigation"] }
      ]
    }
  ],
  "lanes": { "ours": "one line", "techLead": "one line, parked" },
  "demo": { "status": "none", "shape": "", "date": "", "notes": "" },
  "openQuestions": ["one-liner for the platform-team talk"],
  "pushback": ["one-liner: what we don't accept as-is, and why"],
  "agreed": ["problem", "flow", "group:<group name>", "lanes", "pushback", "openQuestions"]
}
```

Rules for the fields:
- `problem` is a single string. `flow` and `openQuestions` are arrays of strings.
- Every item's `tags` may only contain: `diff`, `risk`, `fact`, `option`, `dep`,
  `mitigation`. Nothing else.
- An item that is both a fact and a choice gets `["fact", "option"]`.
- `pushback` is an array of one-liners: what we don't accept in the feature
  as written (see "Check the feature before you start"). Empty = accepted as-is.
- `agreed` is the agree-per-part record (see "Agree per part"). NEVER write a
  key into `agreed` without USER's explicit yes on that part.
- `demo.status` is one of `none` / `scheduled` / `built` — leave it `none` unless a
  demo is actually scheduled or built.
- `demo.notes` is the **demo candidate**: which flow would make the best demo, and
  why, in one or two plain lines. This is the ONLY place a demo idea goes. Do NOT
  put a demo candidate in `openQuestions` — that list is platform-team questions
  only. Leave `notes` an empty string until there's a real candidate.
- Do NOT invent extra top-level keys (no `feature`, `status`, `whatWereSolving`,
  etc.). Feature id/title live on the board and in the folder name, not in here.

Write the readable `discovery.md` too — sprintomatic regenerates it from the JSON,
so you don't hand-maintain it; just keep the JSON right.

## Fact vs diff vs risk — how to actually tag (read this)

**The rule, the standard for every discovery from now on:**

- **diff** = we're changing an existing way of working or an existing design into
  something new. It's a change WE bring.
- **fact** = the product said "this X has to be like Y" — a given we're told to
  match, not a change we're inventing.

So ask one question: is this a change we're making, or a requirement handed to us?
Changing how the team works today → **diff**. A "must be like Y" from the product →
**fact**.

When something reads as both a fact AND a diff, split it by **altitude and cost**:

- **Fact** = the headline that's just true, stated ONCE ("we add a dark
  mode"). It's the ground everyone stands on — too high up to pin a specific cost.
- **Diff** = zoom that fact in until it lands on a real person doing a real thing
  differently ("so every new screen needs its colours picked twice"). The test:
  **can a concrete cost stick to this exact sentence?** If yes → diff.
- Do NOT tag the headline itself as a diff. Break its consequences out into
  separate diff lines. One headline fact → several costed diffs beneath it. That's
  what stops "everything is both, so everything gets both tags."
- **Risk** = what that diff costs (money, a new skill, a new thing that can break, a
  signal people trusted that stops being reliable). **Every diff should have a risk
  pinned right under it.** Diffs and risks travel in pairs — if a diff has no risk,
  you haven't found its cost yet.

Quick chain to remember: **a fact is true → a diff is a fact zoomed in until a cost
sticks → a risk is that cost.**

Two more tags complete the set:

- **dep** = the work waits on someone or something OUTSIDE the team — the
  platform team, another system, a license, an approval. Not a risk (nothing
  is lost yet) and not a fact (it can be chased). Tag it `dep` so it's visible.
- **mitigation** = the ANSWER to a risk, written as its own item right under
  that risk ("risk: every page style needs a dark copy → twice the work" →
  "mitigation: start with the five most used pages, add the rest later"). A risk with no mitigation is fine — it
  honestly means the answer isn't known yet. A mitigation with no nearby risk
  is a smell: what is it answering?

## Discovery meetings — write the record, then offer the findings

When the user says he had a discovery meeting (any phrasing) and tells you
what was discussed, do two things in this order:

1. **Write the record.** Create `discovery/meetings/<YYYY-MM-DD>.md` in the
   feature's folder (create the folder if absent; today's date; if a file for
   the date exists, add a short slug: `<YYYY-MM-DD>-<slug>.md`). First line is
   `# <short title>` naming who/what it was ("Platform team — settings flow"),
   then the summary: plain English, short sentences, what was said and agreed,
   who raised what, what stayed open. Record the MEETING — no tool talk, no
   file paths. `##` sub-headings are fine for topics. Never rewrite an
   existing meeting file; each meeting is its own file, a record.

2. **Then offer the findings.** Read your own summary against the current
   discovery and offer, in one plain line, what it adds — e.g. "I see 2 new
   risks and 1 answered question here — fold them into the discovery?" Only
   on a yes do you update `discovery.json` (tag items as usual). No yes, no
   change. The meeting file stays as-written either way.

**Summaries ONLY in this folder.** Every `.md` file directly in
`discovery/meetings/` shows up as a meeting card on the dashboard — so a raw
transcript there becomes a giant unreadable card. Never save transcripts,
recordings' text, or any raw source material as a meetings file. If the user
hands you a transcript: use it to WRITE the summary, and store the transcript
itself (only if the user wants it kept) in `discovery/meetings/sources/` —
the dashboard deliberately ignores subfolders. Don't keep it at all unless
asked; the summary is the record.

The dashboard shows these files under Discovery → **Meetings**, newest first.

## Every line must be exactly right — name the precise milestone

A discovery line that is dramatic but wrong is WORSE than a missing line, because a
reviewer walks in cold and trusts every line on the page. The most common way to be
wrong: collapsing stages. "Written into the repo", "delivered", and "deployed" are
different milestones — don't blur them. When you write a diff, name the exact stage
that moved, and check the "from today" side is literally true before you write it.

## Agree per part — never hand USER a finished wall

Build the discovery ONE PART at a time: the "accept as-is" check, the problem, the
flow, each context group, the lanes, the open questions. After drafting each
part:

1. **Explain it to USER in simple, non-academic English.** Simplify the
   WORDING, never the content — every detail stays, said plainly.
2. **Ask for USER's take and wait.** This is a conversation, not a broadcast.
3. Only when USER agrees, add that part's key to `agreed` and move on.
   Keys: `problem`, `flow`, `lanes`, `pushback`, `openQuestions`, and
   `group:<group name>` for each group.
4. If an already-agreed part changes later (an edit, a meeting finding folded
   in), REMOVE its key from `agreed` and re-walk that part with USER.

The story-close gate enforces coverage: a discovery cannot close while any
non-empty part is missing from `agreed`. Racing ahead and writing everything
alone just means walking it all back part by part at the end.

## When it's finished

A discovery is finished when the file has a non-empty `flow`, at least one
group whose items include a `diff`, a `risk`, and a `fact` or `option`, AND
every non-empty part is listed in `agreed`. The discovery story on the board
will not close until all of that holds.

## When it's finished, OFFER the HTML pages — do NOT skip this

The moment discovery is finished, OFFER the two HTML pages USER can build from it.
Say it plainly, one short line each, naming the feature by its `displayName`:

> **<feature>** discovery is done. Two things I can build from it now:
> - a **walkthrough** — a slideshow to present the discovery to the room, and
> - a **concept demo** — a scrollable page that pictures the product working.
> Want either? (Neither is needed to close discovery.)

On a yes to the walkthrough, use the `walkthrough` skill; on a yes to the demo,
use the `demo` skill. Each writes a self-contained HTML file into the feature's
`demo/` folder, which the dashboard shows on the D&D page under the Discovery tab
(Walkthrough / Demo sub-tabs). Don't wait to be asked — offering is part of
finishing discovery.

## Plain English + how to write for the page

The reader is a non-native English speaker and some reviewers walk in cold. Short
sentences, everyday words. Read each line aloud — if a friend over coffee wouldn't
say it that way, rewrite it.

The dashboard shows each field back to USER, so WRITE FOR THE EYE, not just the file:

- **One idea per item.** A context item, an open question, a flow step — each is
  ONE thought, not a paragraph. If you're joining sentences with "and … and …",
  split them into separate items.
- **No walls of text.** A single item over ~2 sentences reads as a squashed block.
  Keep it short; the page clamps long items behind a "Show more", which means the
  reviewer stops reading. Short = read.
- **Structure carries meaning.** Use the tags (diff/risk/fact/option/dep/mitigation) and separate
  items to show shape — don't bury a risk mid-sentence inside a diff.
- **Names before numbers** — echo a work item's `displayName` verbatim; never lead
  with a bare id.
- Never dump a heading's number or leftover markdown into the text (no "1. ", no
  raw `**` or `~~`). Write the clean words.
