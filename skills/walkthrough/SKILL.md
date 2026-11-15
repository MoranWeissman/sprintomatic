---
name: walkthrough
description: Use when building a DISCOVERY or DESIGN WALKTHROUGH for a feature — an interactive, self-contained HTML slideshow that presents the findings slide by slide, for showing a room or uploading to another repo. NOT the concept demo (that pictures the product working).
---

# Walkthrough (this workspace)

A walkthrough is one self-contained HTML **slideshow** that presents a
feature's discovery or design — slide by slide — so USER can walk a room
through it. It is NOT the concept demo (that pictures the product working);
this presents what was FOUND or DECIDED.

## The kit — don't rebuild these by hand

Everything the deck is made of already exists in `kit/` next to this file.
Copy from it, never reinvent it. Every number in there was settled in real
reviews and sending it back for a retune costs USER's time.

| file | what it is |
|---|---|
| `kit/template.html` | the deck shell — menu, stage, pager, full-screen picture viewer. Start here. |
| `kit/house-style.css` | the whole look. The build pastes it in; you never copy it by hand. |
| `kit/slide-pieces.html` | copy-paste markup for each kind of slide, with the writing rule above each one. |
| `kit/build-walkthrough.py` | builds `walkthrough.html` from the template + the drawings. |
| `kit/check-slide.py` | renders ONE slide to a PNG so you can look at it. |

How to work:

1. Copy `kit/template.html` into the feature's `design/` (or `demo/`) folder
   as **`walkthrough-template.html`**. This is the file you edit.
2. Write slides into it, copying markup from `kit/slide-pieces.html`.
3. Build and look:
   ```bash
   python3 <this-skill>/kit/build-walkthrough.py     # writes walkthrough.html
   python3 <this-skill>/kit/check-slide.py           # lists the slides
   python3 <this-skill>/kit/check-slide.py 4         # renders slide 4 to a PNG
   ```
4. **LOOK at the PNG before showing anything.** Not "it should be fine".

`walkthrough.html` is GENERATED. Never edit it — the next build wipes your
change. It carries a comment at the top saying so.

Drawings are named, never numbered: `<img src="{{diagram:run-the-tests.svg}}">`.
The build pastes the picture into the file, so it opens offline. A drawing
inside a comment block keeps its placeholder text and is never filled.

## Who reads this, and the one rule everything comes from

USER is not a developer and not a native English speaker. He stands in front
of a room and talks through these slides.

> **His words:** "I dont want to start reading text when i'm going over this."

A slide is not a document he reads out loud. It is a set of points he glances
at and then talks from. Anything he has to read is a failure, however correct
it is.

## How to write

**Bullets: verb first, one action per line, around 8-9 words.**
This took three rounds to settle. Both failures are the obvious things to try,
so don't try them again:

- Full sentences — rejected, too much to read:
  _"when a user turns on dark mode, the settings page saves the choice —
  every page reads it from there"_
- Arrow fragments — rejected, **his words: "its too childish. be strict to
  what it does. period."**
  _"dark mode on → saved, every page = dark"_
- Accepted: _"saves the dark mode choice when the user turns it on"_

No arrows, no `=`, no fragments, no narrating sentence. One exception: a card
about **events** uses "When X happens, the <actor> does Y".

**Simple, plain words.** No academic English. Say it as it is. Some things
USER caught this week, and what to say instead:

| never | say |
|---|---|
| deterministic | always clear, never a coin flip |
| serializes | makes them run one at a time |
| re-registers | enters again at the back |
| mirrors drift | a copy goes stale |
| ordered by the moment each became ready | sorted by the time it was ready |

Also banned everywhere: slack (for spare hours), cleanup moves, pending
decisions, outstanding items, open threads, burndown, scope (as a noun),
velocity, throughput, WIP, in-flight items, work item, blockers.

**Colours are never states.** Say **passed** and **failed**, never "turns
green" / "everything is green" / "all green". Grep for it before you ship —
it hides in design files and inside drawings.

**Never invent a short label that sounds like a heading.** A card title is
the plain name of the thing, nothing more.

| bad | good |
|---|---|
| The stale lock | a lock that got stuck |
| Stalled outside test | a test got stuck and we never hear back |
| The table — it remembers | The settings table |
| From a click to a darker page | Dark mode switch on settings page |

**No placeholder names.** No "Story A", "Item 1", "the first one". Fetch the
real title before writing the sentence.

**No flourishes.** Nothing that sounds like the slide is talking about itself
("we checked", "lives with us").

**Names before numbers**, every time: `**Add a dark mode switch** (#100002)`.
Never the number first, never the number alone.

## How a slide must look

- **3 to 4 bullets per card. Not 6.**
- **Around 8-9 words per bullet.** Longer and he starts reading.
- **Never shrink the text to fit more.** Cut the words instead.
- When you shorten, facts get compressed, not deleted. Two facts fold into one
  line only if one implies the other. Nothing silently disappears.
- Bullet marks are a big dot **•**. Never the thin `·` — he can barely see it.
  (`kit/house-style.css` already does this.)

**The opening slides:**

1. **Intro** — the feature title, the presenter's name, the team name. Nothing else.
   No date, no subtitle, no summary.
2. **"What this feature is about"** — key-point cards, not paragraphs.
   There is **no "why this feature exists" slide** — his words: _"having a
   'why this feature exists' is a bit stupid (sorry) but a short description
   about what's this feature about is a good start. in key points."_
   Don't open with what is wrong today either. His word for that: "dah".

**Menu names** (`data-title`) are short and real: "What it's about", "The big
picture", "Where it shows", "Way 1 — the server holds it". Never the slide title, never
a number.

**Show the deck part by part.** The walkthrough is presented while the design
is still being agreed. Slides for parts with no yes yet stay in the file,
inside the "NOT SHOWN YET" comment block in the template. Nothing is deleted,
nothing is rewritten later.

**Options go up as options, not as a decision.** When there are several ways
to do something, put them side by side so the room picks — his words: _"i want
these 3 options put out."_ One slide per option, all with the same shape: a
row of `.steps` boxes for the path, then a green card for what it buys and an
amber card for what it costs. Same structure every time, so the room compares
like with like.

## How the drawings must behave

This is where the most time gets lost. Read `design/SKILL.md` for how to make
a drawing; this is how it must behave once made.

**Look at every export. Every time.** Text spilling out of its box is the most
common mistake by far, and looking at the picture is the only way it is ever
found:

```bash
drawio -x -f png --width 1200 -o <name>-preview.png <name>.drawio   # 1. a picture to look at
#                                     2. READ the png — check EVERY box for
#                                        text touching or crossing its border
drawio -x -f svg -e --theme light --embed-svg-fonts false \
       -o <name>.svg <name>.drawio                                  # 3. the real export
```

`--embed-svg-fonts false` is not optional. Without it draw.io turns every
label into a picture of text — one drawing went from 42 KB to 1084 KB, and
bitmap text goes blurry the moment someone zooms it in front of a room. The
build script warns you when a drawing still has this. Stay on a common font
(Helvetica or Arial).

**Boxes fit their text, and text is short enough to fit.** When a line does
not fit, the two allowed fixes are: make the box wider or taller, or rebalance
where the line breaks. Shrinking the font is not one of them. Boxes follow the
same rule as slides: 2-3 short lines he can talk from.

**An arrow must never cross a box.** If a note can only reach its target by
cutting through something, the note does not need a line at all.

**Never hang a side note off a decision diamond.** His words: _"if tests passed
then all good, why u have to the side 'the project settings'? looks like a
condiution."_ A dashed line out of a diamond reads as a third branch. A
decision shape has exactly its real branches and nothing else. Side notes sit
in a free corner with **no line attached**. General rule: in a flow chart a
line means flow. Anything that is not flow is not a line.

**A drawing's file name never changes.** Rework the whole content and title if
you want — the file keeps its name. The design files point at drawings by
file name, so a rename quietly breaks the deck.

**Prefer draw.io over hand-written SVG.** Making one box taller in a
hand-written SVG meant a script to shift every element below it down by 52
pixels and re-check every arrow. In draw.io it is a minute. Keep hand-written
SVG only for a drawing that is already finished and stable.

**How a drawing sits on a slide:** `class="slide diag"`, the picture fills the
slide area scaled to fit (never cropped, never stretched), a full-screen
button on every one, and one `.diaghint` paragraph underneath. That hint is
the ONE place a full sentence is allowed — it is what USER says while the room
looks at the picture.

## Discovery walkthrough — what goes on the slides

Read `discovery.json`. One idea per slide, in this order:

1. **Intro** — feature title, name, team.
2. **What this feature is about** — key-point cards.
3. **What we don't accept as-is** — the `pushback` list, one line each. Only
   when it is non-empty. It sits early because it frames the conversation.
4. **The end-to-end flow** — the `flow` steps.
5. **One slide per context group** — its items with tag chips (diff / risk /
   dep / fact / option / mitigation). Keep a diff and its risk paired.
6. **Lanes** — ours vs the tech lead's.
7. **Open questions** — framed as the agenda for the platform-team talk.

Write it to `demo/walkthrough.html`. Offer it in one plain line once the
discovery is complete, naming the feature by its `displayName`:

> **<feature>** discovery is ready — want a walkthrough slideshow to present it?

Build only on a yes.

## Design walkthrough — the funnel order

Read `design.json`, plus the discovery's `problem` line for the opening.
Write `design/walkthrough.html`. Slides go **high level first**, details only
after the big picture landed:

1. Intro
2. What this feature is about
3. **The big picture** — the architecture drawing alone, with 2-3 plain
   sentences under it
4. **Not in this design** — `outOfScope`, when non-empty
5. The approach points
6. One slide per flow, each with its drawing
7. The stories — title, hours, the why line, as a table
8. The working plan
9. Open decisions

`design/diagrams/` also holds `.drawio` sources and `*-preview.png` files.
Only the `.svg` exports go in the deck.

## Colour means the same thing everywhere

Teal and blue = the idea, the happy path. Green = passed, mitigations, the
closing summary. Amber = today, a debate, an open question, a dependency.
Red = a risk, something removed. Violet = accent only. Never recolour by
taste — the dashboard and the concept demo use the same meanings.

## After writing

Tell USER in one line where it shows: the **Walkthrough** sub-tab under
Discovery (or Design) on the D&D page, with Open-in-new-tab and Download.

## Voice

Plain English, short sentences. Some reviewers walk in cold. Every line must
be exactly right — a dramatic-but-wrong line is worse than none.
