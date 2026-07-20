#!/usr/bin/env node
/**
 * BuildingConnected MCP server (zero-dependency, stdio JSON-RPC / MCP).
 *
 * Talks to the BuildingConnected API v2 on Autodesk Platform Services (APS).
 * BuildingConnected only supports *3-legged* OAuth: the user signs in with
 * their Autodesk ID once (bc_login tool), and this server stays authenticated
 * afterwards by rotating APS refresh tokens (they expire after 14 days of
 * disuse, so occasional use keeps the session alive indefinitely).
 *
 * Credentials are loaded (in priority order) from:
 *   1. Environment variables
 *   2. A JSON config file (BC_CONFIG_PATH, else ~/.claude/buildingconnected-credentials.json)
 *
 * Recognized keys (env var  |  config-file key):
 *   BC_CLIENT_ID       |  client_id       (required — APS app Client ID)
 *   BC_CLIENT_SECRET   |  client_secret   (required — APS app Client Secret)
 *   BC_CALLBACK_PORT   |  callback_port   (default 8123; APS app must register http://localhost:<port>/callback)
 *   BC_SCOPES          |  scopes          (default "data:read data:write")
 *   BC_ALLOW_WRITES    |  allow_writes    (default true; "false" blocks POST/PATCH/PUT/DELETE)
 *   (managed)          |  refresh_token   (written automatically by bc_login and on every token refresh)
 *
 * The refresh token is persisted back into the config file — the file must be
 * writable. Never commit this file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const APS_AUTHORIZE_URL = "https://developer.api.autodesk.com/authentication/v2/authorize";
const APS_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";
const BC_BASE_URL = "https://developer.api.autodesk.com/construction/buildingconnected/v2";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configPath() {
  return (
    process.env.BC_CONFIG_PATH ||
    join(homedir(), ".claude", "buildingconnected-credentials.json")
  );
}

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* file is optional until login */
  }

  const pick = (envKey, fileKey, fallback) =>
    process.env[envKey] ?? fileCfg[fileKey] ?? fallback;

  const allowWritesRaw = pick("BC_ALLOW_WRITES", "allow_writes", "true");

  return {
    clientId: pick("BC_CLIENT_ID", "client_id"),
    clientSecret: pick("BC_CLIENT_SECRET", "client_secret"),
    callbackPort: Number(pick("BC_CALLBACK_PORT", "callback_port", 8123)),
    scopes: pick("BC_SCOPES", "scopes", "data:read data:write"),
    refreshToken: fileCfg.refresh_token,
    allowWrites: String(allowWritesRaw).toLowerCase() !== "false",
    configPath: configPath(),
  };
}

let CONFIG = loadConfig();

function saveConfigPatch(patch) {
  const path = CONFIG.configPath;
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* start fresh */
  }
  const merged = { ...fileCfg, ...patch };
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  CONFIG = loadConfig();
}

function requireAppCredentials() {
  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    CONFIG = loadConfig(); // may have been added after startup
  }
  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    throw new Error(
      "Missing APS app credentials. Add client_id and client_secret to " +
        `${CONFIG.configPath} (or set BC_CLIENT_ID / BC_CLIENT_SECRET). ` +
        "See the plugin README for how to create the APS app."
    );
  }
}

// ---------------------------------------------------------------------------
// OAuth (3-legged) token management
// ---------------------------------------------------------------------------

let cachedToken = null; // { accessToken, expiresAt }

function basicAuthHeader() {
  return (
    "Basic " + Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString("base64")
  );
}

async function tokenRequest(form) {
  const res = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`APS token endpoint returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const detail = json.error_description || json.error || text.slice(0, 300);
    const err = new Error(`APS token request failed (${res.status}): ${detail}`);
    err.oauthError = json.error;
    throw err;
  }
  return json;
}

function storeTokens(json) {
  const now = Date.now();
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
  };
  // APS refresh tokens rotate on every use — always persist the newest one.
  if (json.refresh_token) saveConfigPatch({ refresh_token: json.refresh_token });
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }
  requireAppCredentials();
  if (!CONFIG.refreshToken) {
    throw new Error(
      "Not signed in to Autodesk yet. Run the bc_login tool to sign in with " +
        "your Autodesk ID (the account linked to BuildingConnected)."
    );
  }
  let json;
  try {
    json = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: CONFIG.refreshToken,
      scope: CONFIG.scopes,
    });
  } catch (err) {
    if (err.oauthError === "invalid_grant") {
      throw new Error(
        "Autodesk session expired (refresh tokens lapse after 14 days of disuse). " +
          "Run the bc_login tool to sign in again."
      );
    }
    throw err;
  }
  storeTokens(json);
  return cachedToken.accessToken;
}

// ---------------------------------------------------------------------------
// Interactive login (authorization-code flow with localhost callback)
// ---------------------------------------------------------------------------

async function runLoginFlow({ timeout_seconds = 240 } = {}) {
  requireAppCredentials();
  const port = CONFIG.callbackPort;
  const redirectUri = `http://localhost:${port}/callback`;
  const state = randomBytes(16).toString("hex");

  const authorizeUrl =
    `${APS_AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: CONFIG.clientId,
      redirect_uri: redirectUri,
      scope: CONFIG.scopes,
      state,
    }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");
      const gotErr = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (gotErr || gotState !== state || !gotCode) {
        res.end("<h2>BuildingConnected sign-in failed.</h2><p>You can close this tab and try again from Claude.</p>");
        cleanup(new Error(`Autodesk sign-in failed: ${gotErr || "state mismatch / missing code"}`));
      } else {
        res.end("<h2>Signed in.</h2><p>You can close this tab and return to Claude.</p>");
        cleanup(null, gotCode);
      }
    });

    const timer = setTimeout(
      () => cleanup(new Error(`Timed out after ${timeout_seconds}s waiting for the browser sign-in.`)),
      timeout_seconds * 1000
    );

    function cleanup(err, value) {
      clearTimeout(timer);
      server.close();
      err ? reject(err) : resolve(value);
    }

    server.on("error", (e) =>
      cleanup(
        new Error(
          e.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Close whatever is using it or set a different callback_port (and update the APS app's callback URL to match).`
            : e.message
        )
      )
    );

    server.listen(port, () => {
      // Best-effort: pop the user's browser (macOS). The URL is also returned
      // in the error/result text so it can be clicked manually.
      if (process.platform === "darwin") {
        try {
          spawn("open", [authorizeUrl], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* user can click the link instead */
        }
      }
    });
  });

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  storeTokens(tokens);

  // Confirm identity
  const me = await bcRequest({ path: "/users/me" });
  return {
    status: 200,
    data: {
      signed_in: true,
      note: "Refresh token saved; Claude stays signed in as long as the plugin is used at least once every 14 days.",
      user: me.data,
    },
  };
}

// ---------------------------------------------------------------------------
// BuildingConnected REST helper
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

async function bcRequest({ method = "GET", path, query, body }) {
  method = method.toUpperCase();
  if (WRITE_METHODS.has(method) && !CONFIG.allowWrites) {
    throw new Error(`Writes are disabled (allow_writes=false). Refusing ${method} ${path}.`);
  }

  const token = await getAccessToken();

  if (!path.startsWith("/")) path = "/" + path;
  const url = new URL(BC_BASE_URL + path);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const init = { method, headers };
  if (body !== undefined && body !== null && method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    let msg =
      (data && (data.detail || data.message || data.error || JSON.stringify(data))) ||
      raw ||
      res.statusText;
    if (res.status === 403) {
      msg +=
        " (Hint: 403 can mean the signed-in BuildingConnected user lacks a required subscription — " +
        "most endpoints need BuildingConnected Pro; /opportunities needs Bid Board Pro — or the " +
        "Autodesk ID is not linked to a BuildingConnected account.)";
    }
    throw new Error(`BuildingConnected ${method} ${path} -> ${res.status}: ${msg}`);
  }

  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const pagingProps = {
  limit: { type: "integer", description: "Results per page (default 100)." },
  cursor_state: {
    type: "string",
    description:
      "Cursor for the next page — pass the `pagination.cursorState` value from the previous response.",
  },
};

function withPaging(query, { limit, cursor_state }) {
  if (limit !== undefined) query.limit = limit;
  else query.limit = 100;
  if (cursor_state) query.cursorState = cursor_state;
  return query;
}

const TOOLS = [
  {
    name: "bc_login",
    description:
      "Sign in to BuildingConnected via Autodesk (3-legged OAuth). Opens the user's browser to the Autodesk sign-in page and waits for them to approve; then saves a refresh token so future calls need no sign-in. " +
      "Run this when other tools report 'Not signed in' or 'session expired'. Tell the user a browser window will open and they should sign in with the Autodesk ID linked to their BuildingConnected account.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: {
          type: "integer",
          description: "How long to wait for the browser sign-in (default 240).",
        },
      },
    },
    handler: runLoginFlow,
  },
  {
    name: "bc_whoami",
    description:
      "Return the signed-in BuildingConnected user (GET /users/me). Use to confirm connectivity and identity.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => bcRequest({ path: "/users/me" }),
  },
  {
    name: "bc_list_projects",
    description:
      "List BuildingConnected projects (GET /projects). Each project is one phase of bidding. Supports text search and cursor paging. Returns project ids needed by most other calls.",
    inputSchema: {
      type: "object",
      properties: {
        search_text: { type: "string", description: "Free-text search on project name/number." },
        include_closed: { type: "boolean", description: "Include closed projects (default false)." },
        ...pagingProps,
      },
    },
    handler: async ({ search_text, include_closed, limit, cursor_state }) => {
      const query = withPaging({}, { limit, cursor_state });
      if (search_text) query.searchText = search_text;
      if (include_closed !== undefined) query.includeClosed = include_closed;
      return bcRequest({ path: "/projects", query });
    },
  },
  {
    name: "bc_get_project",
    description: "Get one project's full details (GET /projects/{projectId}).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project id." } },
      required: ["project_id"],
    },
    handler: async ({ project_id }) => bcRequest({ path: `/projects/${project_id}` }),
  },
  {
    name: "bc_list_bid_packages",
    description:
      "List bid packages (GET /bid-packages). A bid package is one scope of work within a project, with its own due dates and publication state. Filter by project id.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter to one project (filter[projectId])." },
        ...pagingProps,
      },
    },
    handler: async ({ project_id, limit, cursor_state }) => {
      const query = withPaging({}, { limit, cursor_state });
      if (project_id) query["filter[projectId]"] = project_id;
      return bcRequest({ path: "/bid-packages", query });
    },
  },
  {
    name: "bc_get_bid_package",
    description: "Get one bid package's full details (GET /bid-packages/{bidPackageId}).",
    inputSchema: {
      type: "object",
      properties: { bid_package_id: { type: "string", description: "Bid package id." } },
      required: ["bid_package_id"],
    },
    handler: async ({ bid_package_id }) => bcRequest({ path: `/bid-packages/${bid_package_id}` }),
  },
  {
    name: "bc_list_invites",
    description:
      "List bid invitations sent to subcontractors (GET /invites). Shows who was invited to each bid package and their response state. Filter by project, bid package, or bidder company.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project id." },
        bid_package_id: { type: "string", description: "Filter by bid package id." },
        bidder_company_id: { type: "string", description: "Filter by bidder company id." },
        ...pagingProps,
      },
    },
    handler: async ({ project_id, bid_package_id, bidder_company_id, limit, cursor_state }) => {
      const query = withPaging({}, { limit, cursor_state });
      if (project_id) query["filter[projectId]"] = project_id;
      if (bid_package_id) query["filter[bidPackageId]"] = bid_package_id;
      if (bidder_company_id) query["filter[bidderCompanyId]"] = bidder_company_id;
      return bcRequest({ path: "/invites", query });
    },
  },
  {
    name: "bc_list_bids",
    description:
      "List bids received (GET /bids). Filter by bid package, invite, or bidder company. Set only_latest_revision to skip superseded revisions. Use bc_get_bid / the line-items endpoint for amounts.",
    inputSchema: {
      type: "object",
      properties: {
        bid_package_id: { type: "string", description: "Filter by bid package id." },
        invite_id: { type: "string", description: "Filter by invite id." },
        bidder_company_id: { type: "string", description: "Filter by bidder company id." },
        only_latest_revision: {
          type: "boolean",
          description: "Only return the latest revision of each bid.",
        },
        ...pagingProps,
      },
    },
    handler: async ({
      bid_package_id,
      invite_id,
      bidder_company_id,
      only_latest_revision,
      limit,
      cursor_state,
    }) => {
      const query = withPaging({}, { limit, cursor_state });
      if (bid_package_id) query["filter[bidPackageId]"] = bid_package_id;
      if (invite_id) query["filter[inviteId]"] = invite_id;
      if (bidder_company_id) query["filter[bidderCompanyId]"] = bidder_company_id;
      if (only_latest_revision !== undefined) query.onlyLatestRevision = only_latest_revision;
      return bcRequest({ path: "/bids", query });
    },
  },
  {
    name: "bc_get_bid",
    description:
      "Get one bid's details (GET /bids/{bidId}). For its line-item pricing, call GET /bids/{bidId}/line-items via bc_request.",
    inputSchema: {
      type: "object",
      properties: { bid_id: { type: "string", description: "Bid id." } },
      required: ["bid_id"],
    },
    handler: async ({ bid_id }) => bcRequest({ path: `/bids/${bid_id}` }),
  },
  {
    name: "bc_create_project",
    description:
      "Create a BuildingConnected project (POST /projects). Confirm the details with the user before calling. Pass any additional documented body fields via extra_fields.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name." },
        extra_fields: {
          type: "object",
          additionalProperties: true,
          description:
            "Additional POST /projects body fields (e.g. number, location, client, dates) exactly as the API expects them.",
        },
      },
      required: ["name"],
    },
    handler: async ({ name, extra_fields }) =>
      bcRequest({ method: "POST", path: "/projects", body: { name, ...(extra_fields || {}) } }),
  },
  {
    name: "bc_create_bid_package",
    description:
      "Create a bid package in a project (POST /bid-packages). Confirm the details with the user before calling. Pass any additional documented body fields via extra_fields.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id the package belongs to." },
        name: { type: "string", description: "Bid package name (the scope of work)." },
        extra_fields: {
          type: "object",
          additionalProperties: true,
          description:
            "Additional POST /bid-packages body fields (e.g. dueAt and other date/publication fields) exactly as the API expects them.",
        },
      },
      required: ["project_id", "name"],
    },
    handler: async ({ project_id, name, extra_fields }) =>
      bcRequest({
        method: "POST",
        path: "/bid-packages",
        body: { projectId: project_id, name, ...(extra_fields || {}) },
      }),
  },
  {
    name: "bc_list_bid_line_items",
    description:
      "List a bid's line-item pricing (GET /bids/{bidId}/line-items). The core estimating input: per-line amounts a subcontractor submitted against the bid form. Use after bc_list_bids to pull pricing for leveling or building an estimate.",
    inputSchema: {
      type: "object",
      properties: {
        bid_id: { type: "string", description: "Bid id." },
        ...pagingProps,
      },
      required: ["bid_id"],
    },
    handler: async ({ bid_id, limit, cursor_state }) =>
      bcRequest({
        path: `/bids/${bid_id}/line-items`,
        query: withPaging({}, { limit, cursor_state }),
      }),
  },
  {
    name: "bc_list_project_costs",
    description:
      "List a project's cost/estimate line items (GET /projects/{projectId}/costs). This is BuildingConnected's cost tracking: each cost has a section, code, name, and calculated amount. Use to pull the current estimate for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id." },
        ...pagingProps,
      },
      required: ["project_id"],
    },
    handler: async ({ project_id, limit, cursor_state }) =>
      bcRequest({
        path: `/projects/${project_id}/costs`,
        query: withPaging({}, { limit, cursor_state }),
      }),
  },
  {
    name: "bc_create_project_costs",
    description:
      "Create estimate/cost line items on a project (POST /projects/{projectId}/costs, or costs:batch-create when more than one is given). Each cost needs section, name, and amount; code is optional. Confirm the full list of lines and amounts with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id." },
        costs: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              section: {
                type: "string",
                description: "Estimate section/division, e.g. 'Concrete' or '03 - Concrete'.",
              },
              code: { type: "string", description: "Optional cost code, e.g. '03300'." },
              name: { type: "string", description: "Line item name, e.g. 'Cast-in-place concrete'." },
              amount: { type: "number", description: "Lump-sum amount in the project currency." },
              extra_fields: {
                type: "object",
                additionalProperties: true,
                description:
                  "Additional documented cost fields, merged over the defaults (e.g. a different calculationType/calculation).",
              },
            },
            required: ["section", "name", "amount"],
          },
          description: "Cost line items to create.",
        },
      },
      required: ["project_id", "costs"],
    },
    handler: async ({ project_id, costs }) => {
      const toBody = ({ section, code, name, amount, extra_fields }) => ({
        section,
        ...(code !== undefined ? { code } : {}),
        name,
        calculationType: "LUMP_SUM",
        calculation: { amount },
        ...(extra_fields || {}),
      });
      if (costs.length === 1) {
        return bcRequest({
          method: "POST",
          path: `/projects/${project_id}/costs`,
          body: toBody(costs[0]),
        });
      }
      return bcRequest({
        method: "POST",
        path: `/projects/${project_id}/costs:batch-create`,
        body: costs.map(toBody),
      });
    },
  },
  {
    name: "bc_update_project_cost",
    description:
      "Modify one cost/estimate line item (PATCH /projects/{projectId}/costs/{costId}). Pass only the fields to change (section, code, name, or amount). Confirm the change with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project id." },
        cost_id: { type: "string", description: "Cost line item id (from bc_list_project_costs)." },
        section: { type: "string", description: "New section, if changing." },
        code: { type: "string", description: "New cost code, if changing." },
        name: { type: "string", description: "New name, if changing." },
        amount: { type: "number", description: "New lump-sum amount, if changing." },
        extra_fields: {
          type: "object",
          additionalProperties: true,
          description: "Additional documented cost fields to set, merged over the above.",
        },
      },
      required: ["project_id", "cost_id"],
    },
    handler: async ({ project_id, cost_id, section, code, name, amount, extra_fields }) => {
      const body = {
        ...(section !== undefined ? { section } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(amount !== undefined
          ? { calculationType: "LUMP_SUM", calculation: { amount } }
          : {}),
        ...(extra_fields || {}),
      };
      if (Object.keys(body).length === 0) {
        throw new Error("Nothing to update — pass at least one of section/code/name/amount/extra_fields.");
      }
      return bcRequest({
        method: "PATCH",
        path: `/projects/${project_id}/costs/${cost_id}`,
        body,
      });
    },
  },
  {
    name: "bc_request",
    description:
      "Escape hatch: make an arbitrary BuildingConnected API v2 call. Use for any endpoint without a dedicated tool (bid line items, project bid forms, scope-specific bid forms, project costs, project team members, invites:import-emails, opportunities, users, offices, companies, contacts, TradeTapp, ...). " +
      "Path is relative to /construction/buildingconnected/v2, e.g. '/bids/123/line-items'. The Bearer token is added automatically. " +
      "For write methods (POST/PATCH/PUT/DELETE), confirm intent with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          description: "HTTP method (default GET).",
        },
        path: {
          type: "string",
          description: "API path, e.g. '/projects/{id}' or '/invites:import-emails'.",
        },
        query: {
          type: "object",
          description:
            "Query parameters as key/value pairs. Filters use bracket syntax, e.g. {\"filter[projectId]\": \"...\", \"limit\": 50, \"cursorState\": \"...\"}.",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "JSON request body for write methods.",
          additionalProperties: true,
        },
      },
      required: ["path"],
    },
    handler: async ({ method, path, query, body }) => bcRequest({ method, path, query, body }),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "buildingconnected", version: "0.2.0" };
const PROTOCOL_VERSION = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let pending = 0; // in-flight requests, so we don't exit mid-call when stdin closes
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — ack silently.
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "ping":
        return reply(id, {});

      case "tools/list":
        return reply(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });

      case "tools/call": {
        const tool = TOOL_MAP.get(params?.name);
        if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(params.arguments || {});
          return reply(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          return reply(id, {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          });
        }
      }

      default:
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return replyError(id, -32603, err.message);
  }
}

// stdin reader: buffer and split on newlines
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // ignore malformed lines
    }
    pending++;
    Promise.resolve(handleMessage(msg)).finally(() => {
      pending--;
      maybeExit();
    });
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});

// Announce readiness on stderr (visible in MCP logs, not part of the protocol stream)
process.stderr.write(
  `[buildingconnected-mcp] ready (base=${BC_BASE_URL}, writes=${CONFIG.allowWrites}, signed_in=${Boolean(CONFIG.refreshToken)})\n`
);
