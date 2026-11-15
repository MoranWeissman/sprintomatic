#!/usr/bin/env python3
"""Render ONE slide to a PNG so you can look at it before showing anyone.

    python3 <this-skill>/kit/check-slide.py              # list the slides
    python3 <this-skill>/kit/check-slide.py 3            # slide 3
    python3 <this-skill>/kit/check-slide.py "Where it shows"  # by menu name
    python3 <this-skill>/kit/check-slide.py all          # every slide

Run it from the folder holding walkthrough.html. PNGs land in .slide-checks/.

Why a script and not a screenshot tool: an active slide fades in from
opacity 0, so a screenshot tool grabs the blank first frame every time. This
pulls the one slide into its own file with the animation switched off.

Default size is 1600x620 — about as short as the dashboard preview frame
gets. If a slide fits there, it fits everywhere.
"""
import pathlib
import re
import subprocess
import sys

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# 1300 is the stage width in a 1600-wide window once the 300px menu is gone.
# 620 tall is about as short as the dashboard preview frame gets.
WIDTH, HEIGHT = 1300, 620

HERE = pathlib.Path.cwd()
SRC = HERE / "walkthrough.html"
OUTDIR = HERE / ".slide-checks"

# Never force `display` here. The slide gets the `active` class instead, so the
# deck's own rules decide the layout — a drawing slide is a flex column, and
# forcing block on it makes the picture spill off the bottom.
FREEZE = """
/* check-slide.py: no fade, so the picture isn't a blank first frame */
*{animation:none !important; transition:none !important}
.slide.active{opacity:1 !important; transform:none !important}
nav.side{display:none !important}
"""


def die(msg):
    sys.exit("check-slide: " + msg)


if not SRC.exists():
    die("no walkthrough.html here — build it first, and run me from its folder")
if not pathlib.Path(CHROME).exists():
    die("Google Chrome not found at %s" % CHROME)

html = SRC.read_text(encoding="utf-8")

# Drop HTML comments first — the "not shown yet" block holds slides too, and
# those must not be counted or rendered.
visible = re.sub(r"<!--.*?-->", "", html, flags=re.S)

styles = "\n".join(re.findall(r"<style>(.*?)</style>", visible, flags=re.S))
slides = re.findall(r'(<section class="slide[^"]*"[^>]*>.*?</section>)', visible, flags=re.S)
if not slides:
    die("no slides found in walkthrough.html")

titles = [
    (re.search(r'data-title="([^"]*)"', s).group(1) if 'data-title="' in s else "(no menu name)")
    for s in slides
]

arg = sys.argv[1] if len(sys.argv) > 1 else None

if arg is None:
    print("%d slides in walkthrough.html:" % len(slides))
    for i, t in enumerate(titles, 1):
        print("  %2d  %s" % (i, t))
    print("\nrender one:  python3 %s <number|name|all>" % pathlib.Path(__file__).name)
    sys.exit(0)

if arg == "all":
    picked = list(range(len(slides)))
elif arg.isdigit():
    n = int(arg)
    if not 1 <= n <= len(slides):
        die("there are %d slides, so %s is out of range" % (len(slides), arg))
    picked = [n - 1]
else:
    picked = [i for i, t in enumerate(titles) if arg.lower() in t.lower()]
    if not picked:
        die("no slide's menu name contains %r" % arg)

OUTDIR.mkdir(exist_ok=True)
for i in picked:
    one = slides[i]
    if 'class="slide' in one and " active" not in one:
        one = one.replace('class="slide', 'class="slide active', 1)
    page = (
        "<!DOCTYPE html><html><head><meta charset='utf-8'><style>"
        + styles
        + FREEZE
        + "</style></head><body><div class='layout'><main class='stage'>"
        + "<div class='slidewrap'>" + one + "</div></main></div></body></html>"
    )
    slug = re.sub(r"[^a-z0-9]+", "-", titles[i].lower()).strip("-") or "slide"
    tmp = OUTDIR / ("%02d-%s.html" % (i + 1, slug))
    png = OUTDIR / ("%02d-%s.png" % (i + 1, slug))
    tmp.write_text(page, encoding="utf-8")
    subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
         "--screenshot=" + str(png), "--window-size=%d,%d" % (WIDTH, HEIGHT),
         "--virtual-time-budget=6000", tmp.as_uri()],
        check=True, capture_output=True,
    )
    tmp.unlink()
    print("%s  (%d KB)" % (png, png.stat().st_size // 1024))

print("\nNow LOOK at the PNG. Check for: text you would have to read, more")
print("than 4 bullets, anything cut off at the bottom.")
