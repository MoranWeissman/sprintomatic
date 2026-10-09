# Azure DevOps access — the two doorways

sprintomatic talks to Azure DevOps through **one seam** (`server/ado-client.ts`), so the
same calls can run two ways, chosen by config:

| Mode  | How it authenticates                 | Setup for the user                  |
|-------|--------------------------------------|-------------------------------------|
| `cli` | Your `az login` session (default)    | Have the Azure CLI installed + logged in |
| `api` | A token stored locally               | Paste a token once at install       |

**Why two:** the CLI is zero-setup if you already use `az`, but it assumes the Azure CLI is
on the machine. A tool meant for other developers can't assume that — the direct-API mode
works anywhere, at the cost of pasting a token. So both are supported, and a setting picks one.

## The seam

`server/ado-client.ts` is the only place that talks to Azure DevOps. It exposes two methods:

- `AdoClient.rest({ method, uri, body?, contentKind? })` — one REST request, returns parsed
  JSON. Callers build a full URI (org/project already in it); the client owns auth + transport.
- `AdoClient.queryWorkItems({ wiql, fields, organization, project })` — runs a WIQL query and
  returns the matching items, hydrated, in WIQL order. This is its own method because the two
  doorways do it differently (see below).

Both implementations live in that one file:

- **`CliAdoClient`** shells out to `az` — `az rest` for plain calls, `az boards query` for WIQL.
- **`RestAdoClient`** calls the API directly with a stored token (HTTP Basic, empty username +
  the PAT as password — the standard ADO scheme).

Every other module (`server/ado.ts`, `server/writes.ts`) calls `getAdoClient()` and never
touches `az` or `fetch` itself.

## Why `queryWorkItems` is its own method

`az boards query --wiql` resolves `@Me`, runs the WIQL, AND returns the selected fields
populated — one call. The raw REST API splits that: POST `_apis/wit/wiql` returns only ids,
then `workitemsbatch` hydrates them. Rather than make every caller know which mode it's in,
the difference is hidden inside the two `queryWorkItems` implementations. Plain reads
(single item, comments, iterations, the batch hydrate itself) are identical in both modes, so
they just go through `rest()`.

## The token + mode (API mode)

Selection is by the `SPRINTOMATIC_ADO_ACCESS_MODE` env var, then the **`ado_access_mode`** setting
(`cli` | `api`), defaulting to `cli` — so an existing `az` user changes nothing. (Environment
first, then setting, is the one rule for every knob — see `docs/configuration.md`.)

API mode needs an Azure DevOps **Personal Access Token** with work-item read/write. It's a
**secret**: `SPRINTOMATIC_ADO_PAT` env or the `ado_pat` setting, never echoed back in chat —
same handling as the Outlook calendar URL. The PAT returning a sign-in HTML page (ADO's way of
saying "bad token") is detected and surfaced as a token problem, not a parse crash.

Because there's no `az` to ask in API mode, the four config values come from settings too:
`ado_org`, `ado_project`, `ado_team`, `ado_user` (the `SPRINTOMATIC_ADO_*` env vars win). After changing the
mode or token, call `resetAdoClient()` + `invalidateAdoConfig()` so the next call rebuilds.

You can set all of this in the dashboard under **Settings**, or with `npm run setup`.
The full list is in `docs/configuration.md`.

## Status — complete

- [x] Step 1 — the seam + `CliAdoClient` (behaviour-preserving).
- [x] Step 2 — every `az rest` call site routed onto the seam (`ado.ts` reads, `writes.ts` writes).
- [x] Step 3 — `RestAdoClient` (direct API + token) with the WIQL→batch and iteration REST equivalents.
- [x] Step 4 — config switch for the mode + token + API-mode config, with env fallbacks.

Tested: `server/ado-client.test.ts` covers the API transport, the WIQL→batch hydrate (order
preserved), bad-token detection, and mode selection. The CLI doorway stays covered end-to-end
by `server/writes.test.ts` (its `az` arg shape is asserted through the mocked child process).
