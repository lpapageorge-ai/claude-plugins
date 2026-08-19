# Procore plugin for Claude Code

Lets Claude **read from and write to Procore** in plain language — "list open RFIs on the
Riverside project", "create an RFI asking the structural engineer about the beam detail",
"pull the budget for job 4412". It talks to the Procore REST API through a bundled,
zero-dependency MCP server using a **service account** (OAuth 2.0 client credentials).

## What's inside

```
procore-plugin/
├── .claude-plugin/plugin.json      # manifest — registers the MCP server
├── server/procore-server.mjs       # the MCP server (Node, no dependencies)
├── skills/procore/SKILL.md         # teaches Claude the endpoints + workflow
├── commands/procore-status.md      # /procore-status connection check
├── procore-credentials.example.json
└── README.md
```

## Prerequisites

- **Node 18+** (you have v24). No `npm install` needed — the server has zero dependencies.
- A **Procore Data Connection app** with the *client credentials* grant enabled, giving you
  a **client ID** and **client secret**. (You said you already have these.) The app's
  service account must be added to the company/projects you want to reach, with permission
  on the relevant tools (RFIs, Submittals, etc.).

## Setup (2 minutes)

### 1. Provide credentials

The server reads credentials from environment variables **or** a JSON file. The file is the
easiest and keeps secrets out of the plugin folder. Create:

```
~/.claude/procore-credentials.json
```

with (see `procore-credentials.example.json`):

```json
{
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "company_id": "123456",
  "base_url": "https://api.procore.com",
  "token_url": "https://login.procore.com/oauth/token",
  "allow_writes": true
}
```

- `company_id` is optional but recommended — it becomes the default so you don't have to
  name the company every time. Find it with `/procore-status` after connecting.
- Set `"allow_writes": false` to make the connection strictly read-only.

> Prefer env vars instead? Set `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`,
> `PROCORE_COMPANY_ID`, `PROCORE_BASE_URL`, `PROCORE_TOKEN_URL`, `PROCORE_ALLOW_WRITES`.
> Env vars win over the file.

Lock down the file:

```bash
chmod 600 ~/.claude/procore-credentials.json
```

### 2. Install the plugin

Point Claude Code at this folder. Either:

- Copy/symlink `procore-plugin/` into your Claude Code plugins directory, or
- Add it as a local plugin via your marketplace/plugin config.

Restart Claude Code (or reload plugins) so the `procore` MCP server starts.

### 3. Verify

Run:

```
/procore-status
```

Claude will confirm the service account (`procore_whoami`), then list your companies and
projects. If it can't authenticate, see **Troubleshooting** below.

## Using it

Just ask, e.g.:

- "What projects do we have in Procore?"
- "List the open RFIs on the Harbor Point project."
- "Who's in the directory for job 4412? I need the PM's user id."
- "Draft and create an RFI on Harbor Point: subject 'Grid line B footing', question
  'Please confirm rebar spacing at the B-line footings.'" *(Claude confirms before writing.)*
- "Pull the current budget view for the Riverside project."

For anything without a dedicated tool, Claude uses the `procore_request` escape hatch to hit
the right REST endpoint (budgets, commitments, change orders, daily logs, punch items, …).
The bundled skill gives it an endpoint cookbook.

## Tools exposed to Claude

| Tool | What it does |
|------|--------------|
| `procore_whoami` | Confirm the authenticated service account. |
| `procore_list_companies` | Companies + ids. |
| `procore_list_projects` | Projects in a company. |
| `procore_get_project` | One project's details. |
| `procore_list_rfis` | RFIs in a project. |
| `procore_create_rfi` | Create an RFI. |
| `procore_list_submittals` | Submittals in a project. |
| `procore_list_directory_users` | Project directory users. |
| `procore_request` | Arbitrary Procore REST call (any endpoint/method). |

## Safety

- **Writes are gated.** The skill instructs Claude to restate and confirm any create/update/
  delete before doing it. Set `allow_writes: false` for a read-only connection.
- **Least privilege.** Give the Procore service account only the company/project access and
  tool permissions it needs.
- **Secrets** live in `~/.claude/procore-credentials.json` (chmod 600), never in the plugin
  folder. `.gitignore` also excludes `procore-credentials.json` and `.env`.

## Troubleshooting

- **`Missing Procore credentials`** — the file/env vars weren't found. Confirm the path
  `~/.claude/procore-credentials.json` and valid JSON, or that `PROCORE_CLIENT_ID` /
  `PROCORE_CLIENT_SECRET` are set in the environment Claude Code launches the server with.
- **`Token request failed (401)`** — wrong client id/secret, or the app isn't enabled for
  client credentials.
- **`403` on a call** — the service account lacks permission on that company/project/tool.
  Add it in Procore and grant the tool permission.
- **`404`** — wrong id, or that resource needs a different API version. Check Procore's API
  reference.
- **Sandbox instead of production** — set `base_url` to your sandbox API host and
  `token_url` to the sandbox login host (e.g. `https://login-sandbox.procore.com/oauth/token`).

## Notes

- Access tokens are cached in memory and auto-refreshed ~1 min before expiry.
- The server targets Procore REST `v1.0`/`v1.1` for the dedicated tools; the escape hatch can
  call any version.
