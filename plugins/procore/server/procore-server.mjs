#!/usr/bin/env node
/**
 * Procore MCP server (zero-dependency, stdio JSON-RPC / MCP).
 *
 * Authenticates to Procore with the OAuth 2.0 *client credentials* grant
 * (a Data Connection App / service account) and exposes tools that let
 * Claude read from and write to the Procore REST API.
 *
 * Credentials are loaded (in priority order) from:
 *   1. Environment variables
 *   2. A JSON config file (PROCORE_CONFIG_PATH, else ~/.claude/procore-credentials.json)
 *
 * Recognized keys (env var  |  config-file key):
 *   PROCORE_CLIENT_ID       |  client_id        (required)
 *   PROCORE_CLIENT_SECRET   |  client_secret    (required)
 *   PROCORE_COMPANY_ID      |  company_id        (default company for scoped calls)
 *   PROCORE_BASE_URL        |  base_url          (default https://api.procore.com)
 *   PROCORE_TOKEN_URL       |  token_url         (default https://login.procore.com/oauth/token)
 *   PROCORE_ALLOW_WRITES    |  allow_writes      (default true; set "false" to block POST/PATCH/PUT/DELETE)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  let fileCfg = {};
  const cfgPath =
    process.env.PROCORE_CONFIG_PATH ||
    join(homedir(), ".claude", "procore-credentials.json");
  try {
    fileCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    /* file is optional */
  }

  const pick = (envKey, fileKey, fallback) =>
    process.env[envKey] ?? fileCfg[fileKey] ?? fallback;

  const allowWritesRaw = pick("PROCORE_ALLOW_WRITES", "allow_writes", "true");

  return {
    clientId: pick("PROCORE_CLIENT_ID", "client_id"),
    clientSecret: pick("PROCORE_CLIENT_SECRET", "client_secret"),
    companyId: pick("PROCORE_COMPANY_ID", "company_id"),
    baseUrl: (pick("PROCORE_BASE_URL", "base_url", "https://api.procore.com") || "").replace(/\/$/, ""),
    tokenUrl: pick("PROCORE_TOKEN_URL", "token_url", "https://login.procore.com/oauth/token"),
    allowWrites: String(allowWritesRaw).toLowerCase() !== "false",
    configPath: cfgPath,
  };
}

let CONFIG = loadConfig();

// ---------------------------------------------------------------------------
// OAuth token management (client credentials)
// ---------------------------------------------------------------------------

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken;
  }
  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    // Credentials may have been added after startup — re-read config lazily.
    CONFIG = loadConfig();
  }
  if (!CONFIG.clientId || !CONFIG.clientSecret) {
    throw new Error(
      "Missing Procore credentials. Set PROCORE_CLIENT_ID and PROCORE_CLIENT_SECRET " +
        `(env) or add client_id/client_secret to ${CONFIG.configPath}.`
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CONFIG.clientId,
    client_secret: CONFIG.clientSecret,
  });

  const res = await fetch(CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 300)}`);
  }

  const expiresInMs = (json.expires_in ?? 7200) * 1000;
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + expiresInMs,
  };
  return cachedToken.accessToken;
}

// ---------------------------------------------------------------------------
// Procore REST helper
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
};

function mimeFor(filename) {
  return MIME_TYPES[extname(filename).toLowerCase()] || "application/octet-stream";
}

function isImage(filename) {
  return (MIME_TYPES[extname(filename).toLowerCase()] || "").startsWith("image/");
}

// Flatten a nested object into Rails-style multipart form fields,
// e.g. { punch_item: { name: "x", ids: [1, 2] } } ->
//   punch_item[name]=x, punch_item[ids][]=1, punch_item[ids][]=2
function flattenToForm(form, obj, prefix = "") {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object") flattenToForm(form, item, `${key}[]`);
        else form.append(`${key}[]`, String(item));
      }
    } else if (typeof v === "object") {
      flattenToForm(form, v, key);
    } else {
      form.append(key, String(v));
    }
  }
}

// files: [{ field: "punch_item[images][]", path: "/abs/path/photo.jpg" }, ...]
async function procoreRequest({ method = "GET", path, query, body, files, companyId }) {
  method = method.toUpperCase();
  if (WRITE_METHODS.has(method) && !CONFIG.allowWrites) {
    throw new Error(
      `Writes are disabled (PROCORE_ALLOW_WRITES=false). Refusing ${method} ${path}.`
    );
  }

  const token = await getAccessToken();

  // Build URL
  if (!path.startsWith("/")) path = "/" + path;
  const url = new URL(CONFIG.baseUrl + path);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const effectiveCompany = companyId ?? CONFIG.companyId;
  if (effectiveCompany) headers["Procore-Company-Id"] = String(effectiveCompany);

  const init = { method, headers };
  if (files && files.length && method !== "GET") {
    // Multipart upload: flatten JSON body into form fields, append files.
    const form = new FormData();
    if (body && typeof body === "object") flattenToForm(form, body);
    for (const f of files) {
      const buf = readFileSync(f.path); // throws a clear error if the path is wrong
      const name = basename(f.path);
      form.append(f.field, new Blob([buf], { type: mimeFor(name) }), name);
    }
    init.body = form; // fetch sets the multipart Content-Type + boundary
  } else if (body !== undefined && body !== null && method !== "GET") {
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

  // Surface Procore pagination hints if present
  const pagination = {};
  for (const h of ["total", "per-page", "current-page"]) {
    const val = res.headers.get(h) || res.headers.get(`x-${h}`);
    if (val) pagination[h] = val;
  }

  if (!res.ok) {
    const msg =
      (data && (data.message || data.error || JSON.stringify(data))) || raw || res.statusText;
    throw new Error(`Procore ${method} ${path} -> ${res.status}: ${msg}`);
  }

  return { status: res.status, data, pagination };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const companyIdProp = {
  company_id: {
    type: ["integer", "string"],
    description:
      "Procore company id. Optional if a default company is configured; overrides it when set.",
  },
};

const pagingProps = {
  page: { type: "integer", description: "Page number (default 1)." },
  per_page: { type: "integer", description: "Results per page (default 100, max 300)." },
};

const TOOLS = [
  {
    name: "procore_whoami",
    description:
      "Return the authenticated service account (GET /rest/v1.0/me). Use to confirm connectivity and identity.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => procoreRequest({ path: "/rest/v1.0/me" }),
  },
  {
    name: "procore_list_companies",
    description:
      "List Procore companies the service account can access (GET /rest/v1.1/companies). Returns company ids needed for most other calls.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => procoreRequest({ path: "/rest/v1.1/companies" }),
  },
  {
    name: "procore_list_projects",
    description:
      "List projects in a company (GET /rest/v1.1/projects). Returns project ids, names, and status. Supports paging.",
    inputSchema: {
      type: "object",
      properties: { ...companyIdProp, ...pagingProps },
    },
    handler: async ({ company_id, page, per_page }) => {
      const cid = company_id ?? CONFIG.companyId;
      if (!cid) throw new Error("company_id is required (no default configured).");
      return procoreRequest({
        path: "/rest/v1.1/projects",
        query: { company_id: cid, page, per_page: per_page ?? 100 },
        companyId: cid,
      });
    },
  },
  {
    name: "procore_get_project",
    description: "Get one project's full details (GET /rest/v1.0/projects/{id}).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        ...companyIdProp,
      },
      required: ["project_id"],
    },
    handler: async ({ project_id, company_id }) =>
      procoreRequest({ path: `/rest/v1.0/projects/${project_id}`, companyId: company_id }),
  },
  {
    name: "procore_list_rfis",
    description: "List RFIs for a project (GET /rest/v1.0/projects/{project_id}/rfis).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        ...companyIdProp,
        ...pagingProps,
      },
      required: ["project_id"],
    },
    handler: async ({ project_id, company_id, page, per_page }) =>
      procoreRequest({
        path: `/rest/v1.0/projects/${project_id}/rfis`,
        query: { page, per_page: per_page ?? 100 },
        companyId: company_id,
      }),
  },
  {
    name: "procore_create_rfi",
    description:
      "Create an RFI in a project (POST /rest/v1.0/projects/{project_id}/rfis). Confirm the details with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        subject: { type: "string", description: "RFI subject/title." },
        question: { type: "string", description: "The RFI question body." },
        assignee_id: {
          type: ["integer", "string"],
          description: "Optional Procore user id of the assignee.",
        },
        due_date: { type: "string", description: "Optional due date (YYYY-MM-DD)." },
        attachment_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional absolute file paths on this computer (photos, drawing snippets, PDFs) to attach to the RFI.",
        },
        ...companyIdProp,
      },
      required: ["project_id", "subject", "question"],
    },
    handler: async ({
      project_id,
      subject,
      question,
      assignee_id,
      due_date,
      attachment_paths,
      company_id,
    }) => {
      const rfi = { subject, question: { body: question } };
      if (assignee_id) rfi.assignee_ids = [Number(assignee_id)];
      if (due_date) rfi.due_date = due_date;
      const files = (attachment_paths || []).map((p) => ({
        field: "rfi[attachments][]",
        path: p,
      }));
      return procoreRequest({
        method: "POST",
        path: `/rest/v1.0/projects/${project_id}/rfis`,
        body: { rfi },
        files,
        companyId: company_id,
      });
    },
  },
  {
    name: "procore_create_punch_item",
    description:
      "Create a punch list (deficiency) item, optionally with photo/drawing attachments (POST /rest/v1.0/punch_items, multipart when files are given). " +
      "Confirm the details with the user before calling. " +
      "Note: if you set a punch_item_manager other than the service account, the service account may lose edit rights on the item afterwards — set all fields in this one call.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        name: { type: "string", description: "Punch item title." },
        description: { type: "string", description: "Punch item description." },
        assignee_id: {
          type: ["integer", "string"],
          description: "Optional Procore user id to assign the work to.",
        },
        punch_item_manager_id: {
          type: ["integer", "string"],
          description: "Optional Procore user id of the punch item manager.",
        },
        final_approver_id: {
          type: ["integer", "string"],
          description: "Optional Procore user id of the final approver.",
        },
        due_date: { type: "string", description: "Optional due date (YYYY-MM-DD)." },
        attachment_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional absolute file paths on this computer. Images are sent as punch_item[images][], other files as punch_item[attachments][].",
        },
        ...companyIdProp,
      },
      required: ["project_id", "name"],
    },
    handler: async ({
      project_id,
      name,
      description,
      assignee_id,
      punch_item_manager_id,
      final_approver_id,
      due_date,
      attachment_paths,
      company_id,
    }) => {
      const punch_item = { name };
      if (description) punch_item.description = description;
      if (due_date) punch_item.due_date = due_date;
      if (assignee_id) punch_item.login_information_ids = [Number(assignee_id)];
      if (punch_item_manager_id) punch_item.punch_item_manager_id = Number(punch_item_manager_id);
      if (final_approver_id) punch_item.final_approver_id = Number(final_approver_id);
      const files = (attachment_paths || []).map((p) => ({
        field: isImage(p) ? "punch_item[images][]" : "punch_item[attachments][]",
        path: p,
      }));
      return procoreRequest({
        method: "POST",
        path: "/rest/v1.0/punch_items",
        query: { project_id },
        body: { project_id, punch_item },
        files,
        companyId: company_id,
      });
    },
  },
  {
    name: "procore_upload_file",
    description:
      "Upload a local file to Procore storage via the two-step Direct File Upload flow (POST /rest/v1.1/projects/{id}/uploads, then push the binary to the returned storage URL). " +
      "Returns the upload uuid. Use it where an endpoint accepts attachments as JSON, e.g. PATCH work_order_contract with { attachments: [{ upload_uuid, filename }] }. " +
      "Needed for resources (commitments, prime contracts, change orders) that do NOT accept direct multipart file fields.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        path: { type: "string", description: "Absolute file path on this computer." },
        ...companyIdProp,
      },
      required: ["project_id", "path"],
    },
    handler: async ({ project_id, path: filePath, company_id }) => {
      const buf = readFileSync(filePath);
      const name = basename(filePath);
      // Step 1: create the upload slot
      const created = await procoreRequest({
        method: "POST",
        path: `/rest/v1.1/projects/${project_id}/uploads`,
        body: {
          response_filename: name,
          response_content_type: mimeFor(name),
          size: buf.length,
        },
        companyId: company_id,
      });
      const slot = created.data || {};
      if (!slot.uuid) throw new Error(`Upload slot missing uuid: ${JSON.stringify(slot).slice(0, 300)}`);
      // Step 2: push the binary to storage (S3 POST policy or presigned PUT)
      if (slot.url && slot.fields) {
        const form = new FormData();
        for (const [k, v] of Object.entries(slot.fields)) form.append(k, String(v));
        form.append("file", new Blob([buf], { type: mimeFor(name) }), name);
        const res = await fetch(slot.url, { method: "POST", body: form });
        if (!res.ok) throw new Error(`Storage POST failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      } else if (slot.url) {
        const res = await fetch(slot.url, {
          method: "PUT",
          headers: { "Content-Type": mimeFor(name) },
          body: buf,
        });
        if (!res.ok) throw new Error(`Storage PUT failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      } else {
        throw new Error(`Upload slot had no storage url: ${JSON.stringify(slot).slice(0, 300)}`);
      }
      return { status: 200, data: { upload_uuid: slot.uuid, filename: name }, pagination: {} };
    },
  },
  {
    name: "procore_list_submittals",
    description: "List submittals for a project (GET /rest/v1.0/projects/{project_id}/submittals).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        ...companyIdProp,
        ...pagingProps,
      },
      required: ["project_id"],
    },
    handler: async ({ project_id, company_id, page, per_page }) =>
      procoreRequest({
        path: `/rest/v1.0/projects/${project_id}/submittals`,
        query: { page, per_page: per_page ?? 100 },
        companyId: company_id,
      }),
  },
  {
    name: "procore_list_directory_users",
    description:
      "List users in a project's directory (GET /rest/v1.0/projects/{project_id}/users). Useful for finding assignee ids.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: ["integer", "string"], description: "Project id." },
        ...companyIdProp,
        ...pagingProps,
      },
      required: ["project_id"],
    },
    handler: async ({ project_id, company_id, page, per_page }) =>
      procoreRequest({
        path: `/rest/v1.0/projects/${project_id}/users`,
        query: { page, per_page: per_page ?? 100 },
        companyId: company_id,
      }),
  },
  {
    name: "procore_request",
    description:
      "Escape hatch: make an arbitrary Procore REST API call. Use for any endpoint not covered by a dedicated tool (budgets, commitments, change orders, daily logs, observations, punch items, etc.). " +
      "Path is relative to the API host, e.g. '/rest/v1.0/projects/123/rfis'. The Procore-Company-Id header and Bearer token are added automatically. " +
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
          description: "API path, e.g. '/rest/v1.0/projects/{id}/rfis'.",
        },
        query: {
          type: "object",
          description: "Query string parameters as key/value pairs.",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "JSON request body for write methods.",
          additionalProperties: true,
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: {
                type: "string",
                description:
                  "Multipart form field name, e.g. 'punch_item[images][]' or 'attachments[]'.",
              },
              path: { type: "string", description: "Absolute file path on this computer." },
            },
            required: ["field", "path"],
          },
          description:
            "Optional file uploads. When present the request is sent as multipart/form-data: the JSON body is flattened into Rails-style form fields and each file is appended under its given field name.",
        },
        ...companyIdProp,
      },
      required: ["path"],
    },
    handler: async ({ method, path, query, body, attachments, company_id }) =>
      procoreRequest({ method, path, query, body, files: attachments, companyId: company_id }),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: "procore", version: "0.3.0" };
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
process.stderr.write(`[procore-mcp] ready (base=${CONFIG.baseUrl}, writes=${CONFIG.allowWrites})\n`);
