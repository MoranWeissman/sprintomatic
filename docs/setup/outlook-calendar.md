# Connect your Outlook calendar to sprintomatic

sprintomatic uses your Outlook calendar to figure out your **real** desk time
during a sprint. Meetings take up part of your week, and a sprint plan that
leaves them out promises hours you don't have. This guide walks through hooking it up.

## What you'll do

1. Publish your calendar from Outlook on the web as a private URL (one click).
2. Give that URL to sprintomatic once.
3. From then on, sprintomatic refreshes it on its own.

No app to install, no IT ticket, no popups during the day.

## What you need

- An Office 365 / Microsoft 365 work or school account.
- A web browser.

## Step 1 — Publish your calendar

1. Open **https://outlook.office.com** in a browser and sign in if it asks.
2. Click the **gear icon** in the top-right corner.
3. At the bottom of the panel that opens, click **View all Outlook settings**.
4. In the settings dialog: **Calendar** (left list) → **Shared calendars**
   (sub-section).
5. Scroll to **Publish a calendar**.
6. From the first dropdown, pick **Calendar** (your main one).
7. From the permission dropdown, pick **the most detailed option your company
   allows**. There are three possible options in increasing order of detail:
   - *Can view when I'm busy* — sprintomatic sees **when** you're busy, not
     **what** the meeting is. Enough for the core capacity math
     ("you've got 18h of real desk time").
   - *Can view titles and locations* — adds the meeting subjects so the helper
     can be smarter ("meeting-heavy Tuesday, clear runway Wednesday").
   - *Can view all details* — the most detail; sprintomatic can mention
     specific events in nudges.

   Enterprise tenants often only allow **busy/free** — that's fine, the
   capacity math still works. If you only see *Can view when I'm busy*, your
   IT has restricted publishing to availability only. You can't change that
   from your side and you don't need to.
8. Click **Publish**.
9. Two links appear: HTML and ICS. **Copy the ICS link** (the one ending in
   `.ics`).

> **Security:** the ICS link is private but anyone who has it can read
> whatever level of calendar detail you chose. Keep it out of public places
> (repos, chats, docs). sprintomatic stores it locally in
> `~/.sprintomatic/data.db` on your computer. It's never sent anywhere else.

## Step 2 — Give the URL to sprintomatic

In Claude Code, just tell the assistant something like:

> *"Here's my Outlook calendar URL: <paste-the-ICS-link>"*

The assistant will call the `calendar_set_url` MCP tool and store it in your
local SQLite. You only do this once per machine.

You can also remove or replace the URL the same way — *"stop using my
calendar"* will clear it, *"use this instead: <new-link>"* will replace it.

## Step 3 — Check it's working

Ask the assistant:

> *"What's my real capacity this sprint?"*

It'll call `capacity_check` and report something like:

> *"This sprint has 80h on paper (8h a day for 10 working days). Meetings
> take about 22h, so you have about 58h at your desk. You've planned 71h of
> tasks, which is 13h more than fits. Want to move something out?"*

Meetings you said "maybe" to are left out by default. Settings → "Meetings
you said maybe to" changes that.

If the URL is wrong or the fetch fails, the answer will surface the error
plainly — no silent failures.

## If "Publish a calendar" is missing

That means your IT has fully disabled calendar publishing in the tenant.
Options:

- **File a ticket** with IT asking them to enable calendar publishing (very
  common, low-risk feature — usually approved).
- **Skip Outlook for now.** Everything else still works. Only the meeting
  hours are missing, so your free hours will look bigger than they really
  are.

## Frequently asked

**Can I publish only my work calendar, not personal?**
Yes — step 6 only publishes the *one* calendar you pick.

**Does the URL refresh automatically when I move a meeting?**
Yes. The ICS feed reflects the current state of your Outlook calendar
whenever sprintomatic fetches it. We cache it for a few minutes to keep
things fast.

**What if I delete the URL from Outlook later?**
sprintomatic will see fetch errors and tell you to either re-publish or
clear the stored URL.

**Can someone else read my calendar with the URL?**
Yes — anyone with the link can read whatever detail level you chose. Treat
it like a private share link.

**Why not connect via Microsoft Graph?**
That needs an app registered with your company's Microsoft sign-in, which
most companies don't allow. Publish-URL is the user-level path that works without IT.
