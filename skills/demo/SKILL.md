---
name: demo
description: Use when building a CONCEPT DEMO for a feature whose discovery is done — one self-contained, scrollable HTML page that throws a convincing picture of the idea on screen. NOT a working system, NOT slides. Fast, honest, flashy.
---

# Concept demo (this workspace)

A concept demo is one long **scrollable** HTML page that pictures the feature
working, to show a stakeholder or think out loud — before any real build. It is
NOT a working system and NOT a slide deck. Build it only once discovery is done.

## When to offer it

The moment the feature's discovery is complete (its `discovery.json` has a
non-empty `flow` AND at least one group with a diff, a risk, and a fact-or-option),
offer in one plain line, naming the feature by its `displayName`:

> **<feature>** discovery looks complete — want me to build a concept demo?

Do not build without a yes.

## Pick the flow (2–3 ideas first)

Read the discovery — especially `demo.notes` (the demo candidate) and `flow`.
Offer 2–3 demo ideas in plain words, one line each: which flow to show and why.
Let the user pick one. Build only the picked one.

## Write the file — copy THIS layout (the house pattern)

Write one self-contained HTML file to `demo/concept-demo.html` in the feature's
folder (create `demo/` if absent). No CDN, no external files — it must open
offline. Reproduce this exact structure; it is the approved house style, proven in
a real design review. Don't invent a different shape.

One centered column: `.wrap { max-width:1200px; margin:0 auto; padding:28px 22px 90px }`.
Top to bottom:

1. **Honest banner** (`.topnote`) — a small amber pill with a pulsing dot: e.g.
   "Illustrative concept for design review — not a working system · all steps
   mocked/animated." Never pretends to be real. This is what makes it safe in
   discovery.
2. **Header** — a huge gradient `<h1>` (`clamp(34px,6vw,68px)`, weight 800,
   white→teal→blue→violet clipped to text), a muted `.sub` line, and a `.badge-row`
   of small `.badge` chips naming the key parts.
3. **Developer hero — THE STAR** (`.devhero`) comes FIRST, before any
   architecture. A rounded card with big radial glows. Inside:
   - an `.eyebrow` pill ("The developer experience"),
   - a giant gradient `<h2 class="big">` first-person feeling line
     ("I merged my PR. It was live in DEV before I closed the tab."),
   - a `.devflow` grid of 4 `.devstep` cards — first person, one moment each,
     revealed with staggered `animation-delay`, joined by `→` arrows, the first
     marked `.lit`,
   - a `.devbenefits` row of `.kill` pills: wins as `<span class="yay">✓</span>` and
     killed pain as `<s>manual steps</s>`, `<s>deploy tickets</s>`, `<s>waiting on ops</s>`,
   - a `.devpunch` closing gradient line ("↓ Watch it happen ↓").
4. **Numbered pillars** (`<section>` with `.kick` = a gradient `.num` "01" pill + an
   `<h2>` + a right-aligned dashed `.tag`). One idea each. The **star pillar** has an
   INTERACTIVE animated flow inside a `.hero` card:
   - controls: `▶ Run pipeline` (`.btn.primary`), `Step ›`, `↺ Reset`, and an
     auto-advance `.switch` toggle,
   - a `.track` of `.stage` nodes joined by a `.rail` whose `.fill` grows; nodes move
     through states `queued → running (breathe + spin) → success (green ✓)`,
   - a fake `.console` that prints timestamped colored log lines as stages fire,
   - optionally a `.yaml` two-column peek: a `.code` config block + a `.note`
     explainer. Drive it all with a small vanilla-JS `STAGES` array (icon, label,
     log lines) and `advance()/jumpTo()/reset()` functions.
   Later pillars can use: a promotion `.panel` with clickable `.env` targets and a
   `.gates` list that runs through `wait → pass`, a rendered `.diff` (red `.rm` /
   green `.ad` lines), and a `.choke` two-lane deny-vs-allow with a typed terminal
   (`typeInto()` + an IntersectionObserver to play on scroll).
5. **"Behind the scenes" layer** (`.backstage`, slightly dimmed) — a dashed
   `.bs-frame` with a `.bs-label`, a `.bs-flow` of `.bs-box` steps (bot → config
   repo → sync → the `.chokebox` access-check chokepoint → server). Honest about the
   machinery under the shiny view; developers never touch it.
6. **A dashed "Alternative / out of scope" aside** (`<aside class="alt">`) — amber,
   dashed border, hatched background, an `.alt-badge` "Alternative · out of current
   scope", a `.who` line naming whose proposal it is, and an `.alt-diagram` of
   pills. The discovery debate made visible: the shipped idea vs the thing still
   argued, clearly separated as NOT in this feature.
7. **Footer** — one muted line repeating "concept · mocked & animated · not a
   production system".

## The look (tokens — use verbatim in `:root`)

```
--bg:#07090f; --bg2:#0c1120; --card:#0f1524; --ink:#e8ecf6; --muted:#8792ad;
--line:#1b2337; --accent:#5eead4; --accent2:#7c9dff; --violet:#b088ff;
--amber:#ffcc66; --danger:#ff6b81; --green:#4ade80;
```
- Body: `"Segoe UI", system-ui` font over `--bg` with two soft radial glows
  (top-right blue, left teal). Deep navy, loud, high energy.
- Big gradient headlines (white→teal→blue→violet via `-webkit-background-clip:text`),
  `clamp()` sizing, weight 800–900.
- Section chrome: the gradient numbered pill + h2 + right-aligned dashed tag.
- Functional color: teal/blue = the happy path, green = success/pass, amber =
  debate/out-of-scope, red = denied/removed, violet = accent flourish.
- Keyframes `pulse`, `breathe`, `spin`, `in` (fade-up) are the toolkit — but ALWAYS
  end the stylesheet with
  `@media (prefers-reduced-motion: reduce) { * { animation-duration:.001s !important } }`.
  Flashy by choice, accessibility-safe.

This loud style is the OPPOSITE of the calm sprintomatic dashboard, and that is
fine — a demo's job is to wow a room, the dashboard's job is to stay calm. The
dashboard shows this file in a SEALED frame; it never copies the look. Keep it a
separate self-contained file.

## Tool look-alikes (when the flow lives in git / CI / CD)

When the picked flow runs through git, a pipeline, or a deploy, don't invent an
abstract diagram — redraw the screens the team already stares at every day.
Recognition is what sells the demo. Two building blocks, both self-contained:

**1. Fake terminal window.** A dark rounded box with a title bar (three small
mac dots + a muted title like `zsh — deploy`), `$ ` prompt lines, and a blinking
`▍` cursor. Commands type themselves letter by letter (`typeInto()`), then output
lines appear one by one with a small delay. Use the REAL command shapes the team
types (`git push`, `make deploy`) and plausible output, colored with
the functional palette (green success lines, amber warnings). 5–10 output lines
max per command — pick the lines that tell the story, never dump a full log.

**2. Fake GitHub workflow run.** Reproduce the recognizable signatures, not the
whole page: a left rail of step names each with a status icon that advances
`queued (gray ○) → running (amber spinner) → done (green ✓)`; the current step
expanded, streaming 4–6 monospaced log lines; optionally a fake PR checks row
where a yellow dot turns into a green check. Drive it with the same `STAGES`
array pattern as the star pillar.

**Deploy-tool rule: never draw a web UI the team does not use.** When the team
talks to its deploy tool through a CLI inside the workflow, a fake screen of
that tool's web UI would read as "we don't use that". Instead, show the tool's
CLI output inside a workflow step or terminal: a short resource table (KIND /
NAME / STATUS columns), then `Status: Synced` and `Health: Healthy`. If the demo
needs a visual "it worked" moment after the deploy, end with a small neutral
status card in the demo's own style ("app deployed · 3 copies healthy") — not an
imitation of the tool.

Fidelity bar: a teammate should recognize each screen at a glance; pixel-perfect
is wasted effort. All names, timestamps and log lines are invented — plausible,
consistent with each other, and covered by the honest banner.

## After writing

Mark the demo built so the dashboard reflects it: set the discovery's demo status
to `built` (the dashboard's Demo sub-tab and `orient` read this). Tell the user in
one line where it shows: the **Demo** sub-tab under Discovery on the D&D page.

If the discovery marked this feature as client-facing (used directly by an
end-client, e.g. a developer), also remind USER once: "want to show this demo
to the end-clients before design starts?"

## Voice

Plain English, short sentences. The reader/viewer may be a non-native speaker and
some walk in cold. Every line must be honest — a dramatic-but-wrong line is worse
than no line, because a cold viewer trusts the screen.

The same writing rules the walkthrough runs on apply to every word here:

- **A line is verb first, one action, around 8-9 words.** Not a full
  sentence, and not an arrow fragment either ("all checks passed → in the
  queue" was rejected as childish). Say: "adds a PR to the queue when all
  its checks pass". A line about an EVENT is the exception, and reads
  "When X happens, the <actor> does Y".
- **3 to 4 points per card. Not 6.** Never shrink the text to fit more —
  cut the words instead.
- **Colours are never states.** Say **passed** and **failed**, never
  "turns green" or "all green".
- **Never invent a short label that sounds like a report heading.** Call
  the thing by its plain name: "a lock that got stuck", not "The stale
  lock".
- **No placeholder names** — no "Story A", no "the first one". Fetch the
  real title first.
- **Names before numbers** — echo `displayName` verbatim.
- Words that never appear: deterministic, serializes, re-registers,
  mirrors drift — plus the standing bans (slack for spare hours, cleanup
  moves, burndown, scope as a noun, velocity, WIP, work item, blockers).
