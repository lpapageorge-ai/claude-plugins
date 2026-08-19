# Turnkey Construct — Claude plugin marketplace

Internal marketplace for distributing Turnkey Construct's custom Claude plugins to the team,
with version tracking and updates. Currently ships two plugins: **BuildingConnected** and **Procore**.

---

## For the maintainer (Leo): host it once

The team subscribes to a **git repo**, so this folder needs to live in one. Do this once:

1. Create a **private** repository (GitHub, GitLab, Azure DevOps, etc.) your team can access —
   e.g. `turnkey-construct/claude-plugins`.
2. Push the contents of this folder (`turnkey-marketplace/`) to the repo root:

   ```bash
   cd "turnkey-marketplace"
   git init
   git add .
   git commit -m "Turnkey marketplace"
   git branch -M main
   git remote add origin git@github.com:lpapageorge-ai/claude-plugins.git
   git push -u origin main
   ```

3. Give teammates access to that repo (private repos use each person's own git credentials).

> Real credentials files (`buildingconnected-credentials.json`, `procore-credentials.json`) are
> **git-ignored** and are never in this repo — only the placeholder examples are. Each teammate
> supplies their own (see per-plugin setup below).

## Publishing an update (so the team gets it)

Updates are **version-gated**: teammates only receive a new version when you bump the version number.
On every release:

1. Edit `plugins/<plugin>/.claude-plugin/plugin.json` → bump `version`.
2. Edit `.claude-plugin/marketplace.json` → set the matching `version` on that plugin's entry.
3. Commit and push.

Teammates refresh the catalog (see below) and get the new version.

---

## For teammates: install it once

**In the Claude desktop app:** Settings → open the plugins/marketplace area → add marketplace by
git URL (`lpapageorge-ai/claude-plugins` or the full URL) → install **BuildingConnected** and/or
**Procore**.

**Or via Claude Code commands** (same underlying system):

```
/plugin marketplace add lpapageorge-ai/claude-plugins
/plugin install buildingconnected@turnkey-construct
/plugin install procore@turnkey-construct
```

To pull later updates:

```
/plugin marketplace update turnkey-construct
```

(The app refreshes marketplaces for you; run this to force it.)

---

## One-time setup each teammate still needs

Plugins ship the **code, not credentials**. Each person connects with their own credentials file.

### BuildingConnected (Autodesk 3-legged OAuth — sign in as yourself)

1. **APS app credentials** — reuse a shared Autodesk Platform Services app's Client ID/Secret, or
   create your own (free) at <https://aps.autodesk.com> with the BuildingConnected API enabled and
   callback `http://localhost:8123/callback`.
2. Save them to `~/.claude/buildingconnected-credentials.json` (copy the example and fill in the
   values, or paste the values into Claude and ask it to write the file).
3. In Claude, say **"check my BuildingConnected connection"** — a browser opens for a one-time
   Autodesk sign-in, and you're connected.

Data access matches each person's own BuildingConnected permissions/subscription (most endpoints
need BuildingConnected Pro).

### Procore (service account — client credentials)

Procore uses a **service account** (OAuth 2.0 client credentials), so there's no per-person browser
sign-in — everyone connects with the **same Procore Data Connection app** Client ID/Secret. Leo
shares those two secrets **out of band** (password manager / secure message), **never in this repo**.

1. Get the **Client ID** and **Client Secret** for Turnkey's Procore Data Connection app from Leo.
   The app's service account must be added to the company/projects you need, with permission on the
   relevant tools (RFIs, submittals, etc.).
2. Save them to `~/.claude/procore-credentials.json` (copy `procore-credentials.example.json` and
   fill in the values, or paste them into Claude and ask it to write the file):

   ```json
   {
     "client_id": "...",
     "client_secret": "...",
     "company_id": "123456",
     "base_url": "https://api.procore.com",
     "token_url": "https://login.procore.com/oauth/token",
     "allow_writes": true
   }
   ```

   Set `"allow_writes": false` for a read-only connection. Then lock the file down:
   `chmod 600 ~/.claude/procore-credentials.json`.
3. In Claude, run **/procore-status** (or say "check my Procore connection") to confirm.

---

## What's in here

```
turnkey-marketplace/
├── .claude-plugin/
│   └── marketplace.json          # catalog the team subscribes to
├── plugins/
│   ├── buildingconnected/        # the BuildingConnected plugin (source of truth)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── server/buildingconnected-server.mjs
│   │   ├── skills/
│   │   ├── buildingconnected-credentials.example.json
│   │   └── README.md
│   └── procore/                  # the Procore plugin (source of truth)
│       ├── .claude-plugin/plugin.json
│       ├── server/procore-server.mjs
│       ├── skills/procore/SKILL.md
│       ├── commands/procore-status.md
│       ├── procore-credentials.example.json
│       └── README.md
├── .gitignore                    # keeps real credentials out of git
└── README.md
```
