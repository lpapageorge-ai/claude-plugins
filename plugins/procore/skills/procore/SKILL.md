---
name: procore
description: Read from and write to Procore (construction management). Use when the user asks to look up, list, summarize, create, or update Procore data — projects, RFIs, submittals, the directory, budgets, commitments, change orders, daily logs, observations, punch items, drawings, or any other Procore record. Provides an endpoint cookbook and ID-resolution workflow for the Procore MCP tools.
---

# Working with Procore

This skill backs the Procore MCP tools (`procore_*`). Procore is a REST API; almost
everything is scoped by **company id** and then **project id**, so resolving those ids
is usually the first step.

## Golden path for any request

1. **Resolve the company.** If a default company is configured, calls just work. Otherwise
   call `procore_list_companies` and pick the id.
2. **Resolve the project.** Call `procore_list_projects` and match on name (case-insensitive,
   partial). Confirm with the user if multiple projects match.
3. **Resolve sub-entities** (a user to assign, a cost code, etc.) with the relevant list
   endpoint before creating/updating.
4. **Act.** Use a dedicated tool when one exists; otherwise use `procore_request`.

Never guess an id. If you can't resolve one confidently, ask.

## Write safety

Before any **POST / PATCH / PUT / DELETE** (creating or changing Procore data), briefly
restate what you're about to do — project, record type, and key fields — and get the user's
go-ahead. Reads (GET) need no confirmation.

## Dedicated tools

| Tool | Purpose |
|------|---------|
| `procore_whoami` | Confirm connectivity / identity (`GET /rest/v1.0/me`). |
| `procore_list_companies` | List companies + ids. |
| `procore_list_projects` | List projects in a company. |
| `procore_get_project` | Full details for one project. |
| `procore_list_rfis` | RFIs in a project. |
| `procore_create_rfi` | Create an RFI (supports `attachment_paths`). |
| `procore_create_punch_item` | Create a punch list item (supports `attachment_paths`, assignee, manager, due date). |
| `procore_list_submittals` | Submittals in a project. |
| `procore_list_directory_users` | Project directory users (find assignee ids). |
| `procore_request` | **Escape hatch** — any method/path for endpoints without a dedicated tool (supports multipart `attachments`). |

## File attachments

`procore_create_rfi` and `procore_create_punch_item` take `attachment_paths` — absolute
file paths on this computer (user-uploaded chat files live under the session uploads
folder). `procore_request` takes `attachments: [{field, path}]` for any other endpoint;
when present, the JSON `body` is flattened into Rails-style multipart form fields and each
file is appended under its `field` name (e.g. `punch_item[images][]`, `rfi[attachments][]`).

**Financial resources (commitments, prime contracts, change orders) silently ignore
multipart file fields.** For those, use `procore_upload_file` (two-step Direct File Upload,
returns `upload_uuid`), then PATCH the resource with JSON using **`upload_ids`** (verified):
`work_order_contract: { upload_ids: ["<upload_uuid>"] }`. Note: `attachments: [{upload_uuid}]`
is silently ignored — the association key is `upload_ids`.

## `procore_request` cookbook

`path` is relative to the API host. The company header and bearer token are added
automatically. Pass `company_id` to override the default. Common endpoints
(REST v1.0 unless noted — check Procore's API reference for the latest versions and required fields):

**Discovery**
- `GET /rest/v1.1/companies` — companies
- `GET /rest/v1.1/projects?company_id={cid}` — projects
- `GET /rest/v1.0/projects/{pid}` — one project

**Directory**
- `GET /rest/v1.0/projects/{pid}/users` — project users
- `GET /rest/v1.0/companies/{cid}/users` — company users
- `GET /rest/v1.0/vendors?project_id={pid}` — vendors/companies

**RFIs & Submittals**
- `GET|POST /rest/v1.0/projects/{pid}/rfis`
- `GET /rest/v1.0/projects/{pid}/rfis/{id}`
- `GET|POST /rest/v1.0/projects/{pid}/submittals`

**Field / daily**
- `GET|POST /rest/v1.0/projects/{pid}/daily_logs/...` (e.g. `manpower_logs`, `weather_logs`, `notes_logs`)
- `GET /rest/v1.0/observations/items?project_id={pid}`
- `GET|POST /rest/v1.0/punch_items?project_id={pid}` (NOT under /projects/; prefer `procore_create_punch_item`)
- `GET /rest/v1.0/projects/{pid}/incidents`

**Punch item gotchas**
- Set assignee (`login_information_ids`), `punch_item_manager_id`, and `final_approver_id`
  **in the create call**. If the manager is changed away from the service account, the
  account (Standard punch permission) loses edit rights on that item afterwards.
- `due_date` is **silently ignored** by the API (verified: create and PATCH both return 200
  with due_date null) — Procore derives punch due dates from the project's punch list
  settings (days to respond after notification). Don't promise the user a due date; tell
  them it follows the project's punch settings or can be set manually in the UI.

**Financials**
- `GET /rest/v1.0/budget_views?project_id={pid}` then `.../budget_view_detail_rows`
- `GET /rest/v1.0/commitments?project_id={pid}` (purchase orders / subcontracts)
- `GET /rest/v1.0/projects/{pid}/change_orders/...`
- `GET /rest/v1.0/projects/{pid}/prime_contracts`

**Documents & drawings**
- `GET /rest/v1.0/folders?project_id={pid}` and `.../files`
- `GET /rest/v1.0/projects/{pid}/drawing_areas`

## TurnKey subcontract workflow (quotes drive the language)

When the user provides a subtrade quote (PDF or image) for a subcontract
(`work_order_contract`):

1. **Read the quote first** (PDF text extraction or the image in context). Every subtrade
   is different — do NOT apply default/boilerplate inclusions or exclusions.
2. Populate `inclusions` and `exclusions` **using the quote's own language** — the scope
   items, exclusions, qualifications, and conditions exactly as the subtrade wrote them
   (light formatting into bullet lists is fine; do not invent or add items).
3. Build the SOV `line_items` from the quote's pricing breakdown.
4. Attach the quote file to the contract (`procore_upload_file` → PATCH with `upload_ids`).
5. If the quote has no stated exclusions/inclusions, leave the field blank and tell the
   user rather than filling it with assumptions.

## Pagination

List endpoints accept `page` and `per_page` (default 100, max 300). The tool result's
`pagination` block echoes Procore's `total` / `per-page` / `current-page` headers when
present. If `total` exceeds what you fetched, page through before summarizing "all" records.

## Errors

- **401 / token errors** → credentials or scopes issue; tell the user to check the app
  config and permissions in the Procore Developer Portal.
- **403** → the service account lacks permission on that company/project/tool.
- **422** → validation error; the response body lists the offending fields.
- **404** → wrong id or wrong API version for that resource.
