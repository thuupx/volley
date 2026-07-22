import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Session } from "../session.js";
import type { HistoryEntry } from "../session.js";

/** Compact, accurate collection format reference derived from the actual assertion engine
 *  (crates/core/src/assert.rs) and the collection runner (collections.ts). */
const COLLECTION_FORMAT_REFERENCE = `# Lunge Collection Format (v1)

Top-level fields:
  name: <string>                  # collection name
  description: <string>           # optional
  vars: { <name>: <value> }       # optional; values may be literals or {{env.NAME}}
  defaults:                       # optional; applied to every step
    timeoutMs: <int>
    headers: { <name>: <value> }
  steps: [ <step> ]

Step fields:
  id: <string>                    # unique; used by run_collection only/tags + reporting
  type: "http" | "graphql" | "ws" | "sse"
  request: <protocol-specific spec>   # mirrors the matching MCP tool input
  assert: [ <assertion> ]         # optional; list of conditions
  extract: { <varName>: "<jsonpath>" }  # optional; captured values visible to later steps via {{varName}}
  tags: [ <string> ]              # optional; for selective runs
  skip: true                      # optional; skip this step
  continueOnError: true           # optional; keep running after a failed assertion

Request specs (mirror the MCP tool inputs):
  http:    { method, url, headers, query, body, bodyType, auth, timeoutMs, followRedirects }
  graphql: { url, query, variables, headers, auth, timeoutMs }
  ws:      { url, headers, subprotocols, send:[{json|text}], collect:{maxMessages,maxDurationMs,until} }
  sse:     { url, headers, collect:{maxEvents,maxDurationMs} }

auth object:
  { type: "bearer"|"basic"|"apikey", token|username|password|key|value, in: "header"|"query" }

Assertion vocabulary (each item in assert[] is one object):
  { status: 200 }                          # exact status
  { status: { gte: 200, lt: 300 } }        # range via matchers
  { status: { in: [200, 201] } }           # membership
  { header: { name: "content-type", contains: "json" } }
  { header: { name: "x-trace-id", present: true } }
  { jsonpath: "$.user.id", equals: 42 }    # selector + matcher
  { jsonpath: "$.items.length", gte: 1 }   # .length suffix counts array/string/object keys
  { jsonpath: "$.email", matches: ".+@.+" }  # regex
  { jsonpath: "$.token", exists: true }    # presence check
  { jsonpath: "$.name", notEquals: "admin" }
  { jsonpath: "$.tags", contains: "vip" }  # substring / array-member / object-key
  { jsonpath: "$.list", length: 3 }
  { timeMs: { lt: 500 } }                  # latency budget
  { schema: { /* inline JSON Schema */ } } # validate body against JSON Schema
  { not: { jsonpath: "$.error", exists: true } }  # negation

Matchers (apply to status / header / jsonpath / timeMs values):
  equals, notEquals, in, contains, matches (regex), exists,
  gt, gte, lt, lte, min, max, length

WS-specific assertions:
  { anyFrame: { jsonpath: "$.type", equals: "ack" } }   # any frame matches
  { frameCount: { gte: 1 } }                             # frame count

SSE-specific assertions:
  { anyEvent: { jsonpath: "$.event", equals: "notification" } }
  { eventCount: { gte: 1 } }

Variable chaining:
  - Step 1: extract: { token: "$.token" }
  - Step 2: request.headers.Authorization = "Bearer {{token}}"
  - Extracted vars are visible to ALL later steps (not just the next one).
  - Collection vars: {{baseUrl}}, {{env.API_KEY}} — resolved at run time.
  - Env vars: set via set_env tool, referenced as {{env.NAME}} in collection vars.

JSONPath:
  - RFC 9535 syntax: $.a.b, $.items[0], $.items[?@.id==1], $.items[0:5]
  - Filters need double quotes: [?@.name=="x"]
  - search() function for substring: $.items[?search(@.name,"foo")]
  - .length suffix: $.items.length

Example (login -> profile):
  name: Auth flow
  vars: { baseUrl: "https://api.example.com" }
  steps:
    - id: login
      type: http
      request: { method: POST, url: "{{baseUrl}}/login", body: { user: admin, pass: "{{env.PASS}}" } }
      assert: [{ status: 200 }, { jsonpath: "$.token", exists: true }]
      extract: { token: "$.token" }
    - id: profile
      type: http
      request: { method: GET, url: "{{baseUrl}}/me", auth: { type: bearer, token: "{{token}}" } }
      assert: [{ status: 200 }, { jsonpath: "$.role", equals: "admin" } }
`;

interface Step {
  id?: string;
  type?: "http" | "graphql" | "ws" | "sse";
  request?: Record<string, unknown>;
  assert?: unknown[];
  extract?: Record<string, string>;
  tags?: string[];
  skip?: boolean;
  continueOnError?: boolean;
}
interface Collection {
  name?: string;
  description?: string;
  vars?: Record<string, unknown>;
  defaults?: { headers?: Record<string, unknown>; timeoutMs?: number };
  steps?: Step[];
}

function loadExisting(path: string): Collection {
  if (!existsSync(path)) return { steps: [] };
  const text = readFileSync(path, "utf8");
  if (extname(path) === ".json") return JSON.parse(text) as Collection;
  return parseYaml(text) as Collection;
}

function serialize(col: Collection, path: string): string {
  if (extname(path) === ".json") return JSON.stringify(col, null, 2);
  return stringifyYaml(col);
}

/** Convert a history entry to a collection step, stripping assert/extract from request. */
function entryToStep(entry: HistoryEntry, stepId: string): Step {
  const { assert: _reqAssert, extract: _reqExtract, ...cleanRequest } = entry.request;
  return {
    id: stepId,
    type: entry.type as "http" | "graphql" | "ws" | "sse",
    request: cleanRequest,
    assert: entry.assert,
    extract: entry.extract,
  };
}

export function registerHistoryTools(server: McpServer, session: Session): void {
  server.registerTool(
    "collection_format",
    {
      title: "Collection format reference",
      description:
        "Return the Lunge collection format reference: top-level fields, step schema, " +
        "request specs per protocol (http/graphql/ws/sse), full assertion vocabulary " +
        "(status/header/jsonpath/timeMs/schema/not + matchers), WS/SSE-specific assertions, " +
        "variable chaining (extract + {{var}}), and JSONPath syntax. " +
        "Call this BEFORE writing explicit steps for save_collection or reviewing saved output.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: COLLECTION_FORMAT_REFERENCE }],
    }),
  );

  server.registerTool(
    "list_history",
    {
      title: "List request history",
      description:
        "List all requests recorded in this session with full specs (method, url, query, headers, body, auth, assert, extract) " +
        "and extracted values. Use this to review what happened before saving a multi-step collection. " +
        "Each entry has an id (req_1, req_2, ...) for use with save_collection. " +
        "Returns {count, entries:[{id, type, request, assert, extract, extractedValues, responseHandle}]}.",
      inputSchema: {},
    },
    async () => {
      const entries = session.listHistory();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ count: entries.length, entries }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "save_collection",
    {
      title: "Save multi-step collection",
      description:
        "Save multiple requests as a multi-step collection file. Params: " +
        "path (required, .json/.yaml/.yml), " +
        "fromHistory (optional, array of history ids from list_history — saves in specified order; omit to save ALL history), " +
        "steps (optional, explicit step specs — overrides fromHistory; call collection_format first for the schema), " +
        "name (optional, collection name), description (optional), vars (optional), defaults (optional). " +
        "Steps preserve extraction chaining ({{var}} from earlier steps' extract). " +
        "Returns {saved, path, stepCount, stepIds}.",
      inputSchema: {
        path: z.string().describe("Collection file path (.json/.yaml/.yml)."),
        fromHistory: z.array(z.string()).optional().describe("History entry ids to save (e.g. ['req_1','req_3']). Omit to save ALL history."),
        steps: z.array(z.record(z.string(), z.any())).optional().describe("Explicit step specs. Overrides fromHistory if provided."),
        name: z.string().optional().describe("Collection name."),
        description: z.string().optional().describe("Collection description."),
        vars: z.record(z.string(), z.any()).optional().describe("Collection-level variables (e.g. {baseUrl: 'https://...', apiKey: '{{env.API_KEY}}'})."),
        defaults: z.record(z.string(), z.any()).optional().describe("Default settings applied to every step (e.g. {timeoutMs: 10000, headers: {Accept: 'application/json'}})."),
      },
    },
    async (args) => {
      let steps: Step[];

      if (args.steps) {
        // Explicit step specs — use directly.
        steps = args.steps as Step[];
      } else {
        // Pull from history.
        const ids = args.fromHistory;
        let entries: HistoryEntry[];
        if (ids && ids.length > 0) {
          entries = ids
            .map((id) => session.getHistoryEntry(id))
            .filter((e): e is HistoryEntry => e !== undefined);
          if (entries.length !== ids.length) {
            const missing = ids.filter((id) => !session.getHistoryEntry(id));
            return {
              isError: true,
              content: [{ type: "text" as const, text: `save_collection: history entries not found: ${missing.join(", ")}` }],
            };
          }
        } else {
          // No ids specified — save ALL history.
          entries = session.listHistory();
        }

        if (entries.length === 0) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "save_collection: no history entries to save. Make some requests first, or provide explicit steps." }],
          };
        }

        steps = entries.map((entry, i) => entryToStep(entry, entry.id ?? `step-${i + 1}`));
      }

      // Load existing collection (to merge) or start fresh.
      const col = loadExisting(args.path);
      if (args.name) col.name = args.name;
      if (args.description) col.description = args.description;
      if (args.vars) col.vars = { ...(col.vars ?? {}), ...args.vars };
      if (args.defaults) col.defaults = { ...(col.defaults ?? {}), ...args.defaults };
      col.steps ??= [];

      const stepIds: string[] = [];
      for (const step of steps) {
        const id = step.id ?? `step-${col.steps.length + 1}`;
        col.steps.push({ ...step, id });
        stepIds.push(id);
      }

      writeFileSync(args.path, serialize(col, args.path), "utf8");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ saved: true, path: args.path, stepCount: col.steps.length, stepIds }, null, 2),
          },
        ],
      };
    },
  );
}
