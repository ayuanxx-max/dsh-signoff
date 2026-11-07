#!/usr/bin/env node
"use strict";

// A dependency-free MCP server (stdio, JSON-RPC 2.0) that exposes the SignOff CLI as
// tools. Claude Desktop / DSH / any MCP client can call these instead of shelling out.
//
//   node integrations/mcp/server.js
//
// Tools: signoff_run, signoff_status, signoff_doctor, signoff_audit, signoff_explain.
// Every tool forwards to `signoff <subcommand>` in the client's cwd and returns the
// combined stdout/stderr plus the exit code, because the exit code is the verdict.

const { spawnSync } = require("child_process");

const SERVER = { name: "signoff", version: require("../../package.json").version };
const PROTOCOL = "2024-11-05";

const TOOLS = [
  {
    name: "signoff_run",
    description:
      "Run the five SignOff gates in the current repo (P1 tests, P2 coverage, P3 queue, P4 ledger, P5 anti-slop). Returns exit code, stdout and stderr; exit 0 means pass.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "run the pre-push scope (all stages) instead of the staged scope" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "signoff_status",
    description: "Report whether the repo is guarded: installed hooks, config path, last run, install point.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "signoff_doctor",
    description: "Read-only diagnosis of why the gates are not doing what the user expects; with fix=true it repairs what can be proved.",
    inputSchema: {
      type: "object",
      properties: { fix: { type: "boolean", description: "apply the provable repairs, then re-check" } },
      additionalProperties: false,
    },
  },
  {
    name: "signoff_audit",
    description: "Check whether the commits that landed carry a SignOff trailer; sinceInstall limits the window to after `signoff init`.",
    inputSchema: {
      type: "object",
      properties: {
        sinceInstall: { type: "boolean", description: "audit from the recorded install point" },
        range: { type: "string", description: "explicit git range, e.g. origin/main..HEAD" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "signoff_explain",
    description: "Explain what one gate checks and how it decides: p1, p2, p3, p4 or p5.",
    inputSchema: {
      type: "object",
      properties: { gate: { type: "string", enum: ["p1", "p2", "p3", "p4", "p5"] } },
      required: ["gate"],
      additionalProperties: false,
    },
  },
];

function callSignoff(argv) {
  // Always run the bin that ships with this package: same version as the server, no PATH
  // lookup, no shell (spawning `signoff` through cmd.exe is both slower and deprecated).
  const local = require("path").join(__dirname, "..", "..", "bin", "signoff.js");
  const r = spawnSync(process.execPath, [local, ...argv], { encoding: "utf8" });
  return {
    exitCode: r.status === null ? 1 : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function runTool(name, args) {
  switch (name) {
    case "signoff_run": {
      const argv = ["run"];
      if (args && args.full) argv.push("--full");
      return callSignoff(argv);
    }
    case "signoff_status":
      return callSignoff(["status"]);
    case "signoff_doctor":
      return callSignoff(args && args.fix ? ["doctor", "--fix"] : ["doctor"]);
    case "signoff_audit": {
      const argv = ["audit"];
      if (args && args.sinceInstall) argv.push("--since-install");
      if (args && args.range) argv.push("--range", String(args.range));
      return callSignoff(argv);
    }
    case "signoff_explain":
      return callSignoff(["explain", String((args && args.gate) || "")]);
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(req) {
  const { id, method, params } = req || {};
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const r = runTool(name, args);
      const text =
        `exit ${r.exitCode}\n` +
        (r.stdout ? r.stdout.trimEnd() + "\n" : "") +
        (r.stderr ? r.stderr.trimEnd() : "");
      return reply(id, {
        content: [{ type: "text", text: text.trimEnd() }],
        isError: r.exitCode !== 0,
      });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true });
    }
  }
  if (method === "ping") return reply(id, {});
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      fail(null, -32700, "parse error");
      continue;
    }
    if (Array.isArray(req)) req.forEach(handle);
    else handle(req);
  }
});
