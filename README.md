# Turnkey Construct — Claude plugin marketplace

Internal marketplace for distributing Turnkey Construct's custom Claude plugins to the team,
with version tracking and updates. Currently ships one plugin: **BuildingConnected**.

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
   git commit -m "Turnkey marketplace: buildingconnected v0.2.0"
   git branch -M main
   git remote add origin git@github.com:turnkey-construct/claude-plugins.git
   git push -u origin main
   ```

3. Give teammates access to that repo (private repos use each person's own git credentials).

> The real Autodesk credentials file (`buildingconnected-credentials.json`) is **git-ignored** and
> is never in this repo — only the placeholder example is. Each teammate supplies their own.

## Publishing an update (so the team gets it)

Updates are **version-gated**: teammates only receive a new version when you bump the version number.
On every release:

1. Edit `plugins/buildingconnected/.claude-plugin/plugin.json` → bump `version` (e.g. `0.2.0` → `0.2.1`).
2. Edit `.claude-plugin/marketplace.json` → set the matching `version` on the `buildingconnected` entry.
3. Commit and push.

Teammates refresh the catalog (see below) and get the new version.

---

## For teammates: install it once

**In the Claude desktop app:** Settings → open the plugins/marketplace area → add marketplace by
git URL (`turnkey-construct/claude-plugins` or the full URL) → install **BuildingConnected**.

**Or via Claude Code commands** (same underlying system):

```
/plugin marketplace add turnkey-construct/claude-plugins
/plugin install buildingconnected@turnkey-construct
```

To pull later updates:

```
/plugin marketplace update turnkey-construct
```

(The app refreshes marketplaces for you; run this to force it.)

---

## One-time setup each teammate still needs

The plugin ships the code, **not** credentials. BuildingConnected's API uses Autodesk 3-legged
OAuth, so every person signs in as themselves:

1. **APS app credentials** — either reuse a shared Autodesk Platform Services app's Client ID/Secret,
   or create your own (free) at <https://aps.autodesk.com> with the BuildingConnected API enabled and
   callback `http://localhost:8123/callback`.
2. Save them to `~/.claude/buildingconnected-credentials.json` (copy
   `buildingconnected-credentials.example.json` and fill in the two values — or paste the values into
   Claude and ask it to write the file).
3. In Claude, say **"check my BuildingConnected connection"** — a browser opens for a one-time
   Autodesk sign-in, and you're connected.

Data access matches each person's own BuildingConnected permissions and subscription
(most endpoints need BuildingConnected Pro).

---

## What's in here

```
turnkey-marketplace/
├── .claude-plugin/
│   └── marketplace.json          # catalog the team subscribes to
├── plugins/
│   └── buildingconnected/        # the plugin (source of truth)
│       ├── .claude-plugin/plugin.json
│       ├── server/buildingconnected-server.mjs
│       ├── skills/
│       ├── buildingconnected-credentials.example.json
│       └── README.md
├── .gitignore                    # keeps real credentials out of git
└── README.md
```
