---
name: buildingconnected-status
description: Check the BuildingConnected connection — verify sign-in, show who is connected, and walk through Autodesk APS setup or re-login if anything is missing. Use when the user asks "is BuildingConnected connected", "check BC status", "why isn't BuildingConnected working", or wants to set up / sign in to BuildingConnected.
---

# BuildingConnected connection status

Check the connection and guide the user through any fix, in this order:

1. Call `bc_whoami`.
   - **Success** → report the signed-in user (name, email, company) and that the connection is healthy. Done.
2. If it fails with **"Missing APS app credentials"** → the one-time app setup hasn't been done. Walk the user through the README setup (summarize it conversationally, don't just point at the file):
   - Create an app at https://aps.autodesk.com (Applications → Create Application, type "Traditional Web App"), enable the **BuildingConnected API**, set callback URL to `http://localhost:8123/callback`.
   - Put the Client ID and Client Secret into `~/.claude/buildingconnected-credentials.json` as `client_id` / `client_secret` (offer to write the file for them if they paste the values).
   - Their BuildingConnected login must be linked to their Autodesk ID (BuildingConnected does this on modern accounts; if unsure, proceed — an error at sign-in will say so).
   - Then continue to step 3.
3. If it fails with **"Not signed in"** or **"session expired"** → run `bc_login` after telling the user a browser window will open and they should sign in with the Autodesk account linked to BuildingConnected. On success, report who is now signed in.
4. If it fails with a **403** → the sign-in works but the account lacks access: most endpoints need a BuildingConnected Pro subscription (opportunities need Bid Board Pro), or the Autodesk ID isn't linked to a BC account. Report this plainly.
5. Any other error → show the error message and the config file path in play (`~/.claude/buildingconnected-credentials.json` unless `BC_CONFIG_PATH` overrides it).

Also mention, when relevant: writes can be disabled by setting `allow_writes: false` in the credentials file; the callback port can be changed with `callback_port` (the APS app's callback URL must match).
