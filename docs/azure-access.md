# Reaching your Azure DevOps board

sprintomatic can reach your board in one of two ways. `npm run setup` asks
which one you want. You can change it later in the dashboard under Settings.

| Way | What you need |
|-----|---------------|
| **The az command** (the default) | The Azure CLI installed and signed in |
| **A personal access token** | A token you make once on the Azure DevOps website |

Pick the az command if you already use it. Pick a token if you don't want to
install the Azure CLI.

## Way 1: the az command

1. Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli
2. Add its Azure DevOps part: `az extension add --name azure-devops`
3. Sign in: `az login`
4. Optional: tell az your organization and project, so setup can leave those
   questions empty:
   `az devops configure --defaults organization=https://dev.azure.com/your-org project="Your Project"`

When your sign-in runs out, sprintomatic says so and asks you to run
`az login` again.

## Way 2: a personal access token

1. Open your organization on the Azure DevOps website, for example
   `https://dev.azure.com/your-org`.
2. Click the **User settings** icon at the top right (a person with a gear),
   then **Personal access tokens**.
3. Click **New Token**. Give it a name, pick an end date, and under
   **Scopes** choose **Work Items: Read & write**. Nothing else is needed.
4. Click **Create** and copy the token. The website shows it only once.
5. Run `npm run setup`, pick "a personal access token", and paste it when it
   asks.

On a Mac the token is kept in the Keychain. On other systems it is kept as
plain text in `~/.sprintomatic/data.db`. When the token runs out, make a new
one and save it in Settings.

With a token, setup also needs your organization, project, team and sign-in
email, because there is no az to ask.

---

## For developers

### The seam

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

### Why `queryWorkItems` is its own method

`az boards query --wiql` resolves `@Me`, runs the WIQL, AND returns the selected fields
populated — one call. The raw REST API splits that: POST `_apis/wit/wiql` returns only ids,
then `workitemsbatch` hydrates them. Rather than make every caller know which mode it's in,
the difference is hidden inside the two `queryWorkItems` implementations. Plain reads
(single item, comments, iterations, the batch hydrate itself) are identical in both modes, so
they just go through `rest()`.

### How the mode and token are read

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

### Tests

`server/ado-client.test.ts` covers the API transport, the WIQL→batch hydrate (order
preserved), bad-token detection, and mode selection. The CLI doorway stays covered end-to-end
by `server/writes.test.ts` (its `az` arg shape is asserted through the mocked child process).
