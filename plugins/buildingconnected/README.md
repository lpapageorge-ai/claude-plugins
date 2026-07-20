# BuildingConnected plugin for Claude

Lets Claude read from and write to **BuildingConnected by Autodesk** in plain language: projects, bid packages, subcontractor invites, bids and bid leveling, bid forms, project costs — plus a generic escape hatch for any BuildingConnected API v2 endpoint.

Built for Turnkey Construct's GC workflow (BuildingConnected Pro): create projects, break them into bid packages, invite subs, track and compare bids.

## How it connects

BuildingConnected's API runs on **Autodesk Platform Services (APS)** and only supports *3-legged* OAuth — a real person signs in with their Autodesk ID once, and the plugin then stays signed in by rotating refresh tokens. (This differs from the Procore plugin's service-account model; Autodesk simply doesn't offer that for BuildingConnected.)

Practical consequences:

- **One-time browser sign-in**: the first time you use it (and after long gaps), Claude runs `bc_login`, your browser opens an Autodesk sign-in page, you approve, done.
- **14-day idle limit**: if the plugin isn't used at all for 14 days, Autodesk expires the session and Claude will ask you to sign in again. Regular use keeps it alive indefinitely.
- Data access matches **your** BuildingConnected permissions and subscription (most endpoints need BuildingConnected Pro; the sub-side `/opportunities` bid board needs Bid Board Pro).

## One-time setup

### 1. Create an APS app (~5 minutes)

1. Go to <https://aps.autodesk.com> and sign in (create a free developer account if needed — any Autodesk ID works).
2. Open **Applications → Create Application**. Name it e.g. `Claude BuildingConnected`, type **Traditional Web App**.
3. Under **API Access**, make sure **BuildingConnected API** is selected/enabled.
4. Set the **Callback URL** to exactly:

   ```
   http://localhost:8123/callback
   ```

5. Save, and copy the **Client ID** and **Client Secret**.

### 2. Save the credentials

Create `~/.claude/buildingconnected-credentials.json` (see `buildingconnected-credentials.example.json`):

```json
{
  "client_id": "PASTE_CLIENT_ID",
  "client_secret": "PASTE_CLIENT_SECRET",
  "callback_port": 8123,
  "allow_writes": true
}
```

You can also just paste the two values into a Claude chat and ask it to set the file up. Never commit this file — after the first sign-in it also holds your refresh token.

### 3. Link BuildingConnected to your Autodesk ID

Your BuildingConnected login must be linked to an Autodesk ID (accounts created or migrated in recent years already are — you sign in to buildingconnected.com with Autodesk). If sign-in succeeds but API calls return 403, the link or a BuildingConnected Pro subscription is what's missing.

### 4. First sign-in

Ask Claude: *"Check my BuildingConnected connection"*. It will run the sign-in flow (browser window → Autodesk login → "Signed in" page) and confirm who's connected.

## Configuration reference

Config file (default `~/.claude/buildingconnected-credentials.json`, override path with `BC_CONFIG_PATH`); every key also has an env-var override:

| Config key | Env var | Default | Meaning |
|---|---|---|---|
| `client_id` | `BC_CLIENT_ID` | — | APS app Client ID (required) |
| `client_secret` | `BC_CLIENT_SECRET` | — | APS app Client Secret (required) |
| `callback_port` | `BC_CALLBACK_PORT` | `8123` | Local port for the sign-in callback; the APS app's callback URL must match |
| `scopes` | `BC_SCOPES` | `data:read data:write` | OAuth scopes |
| `allow_writes` | `BC_ALLOW_WRITES` | `true` | `false` makes the plugin read-only |
| `refresh_token` | — | managed | Written automatically on sign-in and every token refresh |

## Tools

| Tool | Purpose |
|---|---|
| `bc_login` | Interactive Autodesk sign-in (opens browser, saves refresh token) |
| `bc_whoami` | Signed-in user — connectivity check |
| `bc_list_projects` / `bc_get_project` | Find projects (text search, closed filter) |
| `bc_list_bid_packages` / `bc_get_bid_package` | Scopes of work within a project |
| `bc_list_invites` | Which subs were invited, and their response state |
| `bc_list_bids` / `bc_get_bid` | Bids received (latest-revision filter) |
| `bc_list_bid_line_items` | A bid's line-item pricing — the raw input for leveling and estimating |
| `bc_list_project_costs` | Pull a project's estimate / cost tracking lines |
| `bc_create_project_costs` / `bc_update_project_cost` | Write estimate lines (section, code, name, amount) — batched, confirmed first |
| `bc_create_project` / `bc_create_bid_package` | Writes — Claude confirms details first |
| `bc_request` | Any other API v2 endpoint (bid forms, team members, invites:import-emails, opportunities, …) |

The `buildingconnected` skill teaches Claude the data model, ID-resolution order, cursor pagination, and an endpoint cookbook; `buildingconnected-status` is the guided connection check.

## Security notes

- Secrets live only in the local credentials file (written with `0600` permissions) or env vars — never in the plugin or a repo.
- The refresh token grants API access as you; treat the credentials file like a password.
- All write methods are blocked when `allow_writes` is `false`; when enabled, Claude is instructed to confirm every write with you before sending it.
- The sign-in callback listens on `localhost` only, for a single request, with a CSRF `state` check, and shuts down immediately after.
