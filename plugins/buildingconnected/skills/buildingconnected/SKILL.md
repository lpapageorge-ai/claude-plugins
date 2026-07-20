---
name: buildingconnected
description: Read from and write to BuildingConnected by Autodesk (bid management). Use when the user asks to look up, list, summarize, create, or update BuildingConnected data — projects, bid packages, bid invites, bidders, bids, bid leveling, bid forms, subcontractors, opportunities, or anything about "BC" / "BuildingConnected". Provides the endpoint cookbook, ID-resolution workflow, and auth troubleshooting for the BuildingConnected MCP tools.
---

# BuildingConnected

Work with BuildingConnected (Autodesk's bid management platform) through the `bc_*` MCP tools. Turnkey Construct uses it as a **general contractor**: they create projects, break them into bid packages (scopes of work), invite subcontractors, and track/level incoming bids.

## Auth model — read this first

- BuildingConnected only supports 3-legged OAuth: a human signs in with their Autodesk ID once via the **bc_login** tool; a refresh token then keeps the session alive.
- If any tool errors with "Not signed in" or "session expired", run `bc_login`. Tell the user first: *a browser window will open — sign in with the Autodesk account linked to your BuildingConnected login.* The tool waits up to ~4 minutes for them to finish.
- Refresh tokens lapse after 14 days of disuse; re-running `bc_login` fixes it.
- A 403 usually means a missing subscription (most endpoints need BuildingConnected Pro; `/opportunities` needs Bid Board Pro) or an Autodesk ID not linked to a BC account — not a bug in the call.

## Data model & ID resolution

BC Pro cascades: **Project** (one phase of bidding) → **Bid packages** (one scope of work each, own due dates) → **Invites** (which subs were asked to bid) → **Bids** (received proposals, possibly multiple revisions).

Always resolve IDs top-down; never guess them:

1. `bc_list_projects` with `search_text` to find the project → note `id`.
2. `bc_list_bid_packages` with `project_id` → note bid package ids.
3. `bc_list_invites` / `bc_list_bids` filtered by those ids.

IDs are opaque strings (not integers). When the user names a project loosely ("the Fairview job"), search with `bc_list_projects` and confirm the match if more than one candidate comes back.

## Pagination

List endpoints are cursor-paged: pass `limit` (default 100) and read `pagination.cursorState` / `pagination.nextUrl` from the response body. To fetch the next page, pass that value back as `cursor_state` (dedicated tools) or `cursorState` (via `bc_request`). Keep paging until `cursorState` is absent when the user asks for totals or "all" of something.

## Writes

- Writes are allowed but **always confirm the exact details with the user before any POST/PATCH/DELETE** (project name, package scope, dates, recipients).
- Setting `allow_writes: false` in the credentials file makes the plugin read-only.
- Create tools accept `extra_fields` passed through verbatim to the API body — use documented camelCase field names.

## Endpoint cookbook (via `bc_request` when no dedicated tool exists)

Paths are relative to `/construction/buildingconnected/v2`. Filters use bracket query params, e.g. `{"filter[projectId]": "..."}`.

| Task | Call |
|---|---|
| Who am I | `GET /users/me` |
| Projects | `GET /projects?searchText=...&includeClosed=true` · `POST /projects` · `PATCH /projects/{id}` |
| Bid packages | `GET /bid-packages?filter[projectId]=...` · `POST /bid-packages` · `PATCH /bid-packages/{id}` |
| Invites (who's bidding) | `GET /invites?filter[bidPackageId]=...` |
| Invite subs by email | `POST /invites:import-emails` (check the API reference for the exact body if a 400 comes back) |
| Bids | `GET /bids?filter[bidPackageId]=...&onlyLatestRevision=true` |
| Bid pricing detail | `GET /bids/{bidId}/line-items` · `GET /bids/{bidId}/plugs` |
| Project-wide bid form | `GET /project-bid-forms?filter[projectId]=...` · `.../line-items` |
| Scope-specific bid forms | `GET /scope-specific-bid-forms?filter[projectId]=...` · `.../line-items` |
| Project costs / estimate | dedicated tools below; batch patch/delete via `PATCH .../costs:batch-patch`, `POST .../costs:batch-delete` |
| Project team | `GET /project-team-members?filter[projectId]=...` |
| Opportunities (Bid Board, sub-side) | `GET /opportunities` — needs Bid Board Pro |

Many batch operations exist as `:batch-create` / `:batch-patch` / `:batch-delete` action suffixes on the collection path.

If an endpoint 400s on body shape, fetch the reference page `https://aps.autodesk.com/en/docs/buildingconnected/v2/reference/http/` for that resource before retrying.

## Estimating (project cost tracking)

A project's estimate lives in its **costs**: line items with `section` (division/grouping), optional `code`, `name`, and a calculated amount (`calculationType: "LUMP_SUM"` with `calculation: { amount }` is the verified shape; other calculation types may exist — check the API reference before using one via `extra_fields`).

- **Pull an estimate**: `bc_list_project_costs` → group by `section`, sum amounts, report the total.
- **Create estimate lines**: `bc_create_project_costs` — takes an array; one call handles a whole estimate (it batches automatically). Section/name/amount per line; use cost codes when the user has them.
- **Revise a line**: `bc_update_project_cost` with only the changed fields.
- **Estimating inputs**: bid pricing via `bc_list_bid_line_items`; the bid form structure via `/project-bid-forms` and `/scope-specific-bid-forms` line items.

## Common workflows

- **"Bid status on project X"**: resolve project → list bid packages → for each, list invites (response states) and bids (`onlyLatestRevision=true`) → summarize coverage per scope: invited / viewed / will-bid / bids received, flag packages near their due date with thin coverage.
- **Bid leveling**: list bids for a package (`onlyLatestRevision=true`) → `bc_list_bid_line_items` per bid → tabulate side by side.
- **Build an estimate from leveled bids**: for each bid package, level the bids and pick the selected number (low bid unless the user says otherwise) → present the proposed cost lines (section = scope/division, name, amount) as a table with the total → **after the user approves**, write them in one `bc_create_project_costs` call. Add non-bid lines (GCs/GRs, insurance, contingency, fee) only if the user gives them.
- **"Set up bidding for a new job"**: confirm details → `bc_create_project` → `bc_create_bid_package` per scope → invites via `POST /invites:import-emails`.
