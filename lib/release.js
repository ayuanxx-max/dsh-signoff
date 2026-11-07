#!/usr/bin/env node
"use strict";

// signoff release - the gate that P1..P5 never covered: the published artifact.
//
// The other gates read the working tree, so a release could be "green" while the
// tarball would not start, while server.json pointed at an older package version, or
// while the registry listed a version nobody had published. Every one of those has
// happened in this repo (3.9.4 pinned for ~40 releases; 4.0.0 unlaunchable through npx).
//
// Two halves, because the facts live in different places:
//   --pre   offline: manifests agree, the tarball installs, the installed CLI runs,
//           and `signoff mcp` completes an initialize handshake.
//   --post  online: what npm and the MCP registry now say about this version.
//
// Exit code is the verdict: 0 pass, 1 red, 2 usage/environment.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function findRoot(from) {
  let dir = path.resolve(from || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 180000, shell: process.platform === "win32", ...opts });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function httpGet(url, timeoutMs) {
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { "user-agent": "signoff-release", accept: "application/json" }, timeout: timeoutMs || 20000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "", error: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
  });
}

// A slow, explicit handshake: start the installed CLI's mcp server, send initialize,
// and require a JSON response that echoes our id.
function mcpHandshake(binPath, timeoutMs) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(process.execPath, [binPath, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) { /* already gone */ }
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, "no response in " + (timeoutMs || 8000) + "ms"), timeoutMs || 8000);
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            const name = msg.result.serverInfo && msg.result.serverInfo.name;
            finish(true, "initialize ok" + (name ? " as " + name : ""));
          }
        } catch (e) { /* partial line */ }
      }
    });
    child.on("error", (e) => finish(false, e.message));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "signoff-release", version: "0" } } }) + "\n");
  });
}

function parseArgs(argv) {
  const opts = { pre: false, post: false, json: false, keep: false };
  for (const a of argv) {
    if (a === "--pre") opts.pre = true;
    else if (a === "--post") opts.post = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else return { error: "unknown argument: " + a };
  }
  if (!opts.pre && !opts.post) opts.pre = true;
  return opts;
}

const HELP = `signoff release [--pre] [--post] [--json]

  --pre    offline: manifests agree, npm pack succeeds, the tarball installs,
           the installed CLI answers --version, and its mcp server handshakes
  --post   online: npm dist-tags, the MCP registry entry, README raw links
  --json   machine-readable result
  --keep   keep the temporary install directory and print its path

  Run --pre before npm publish, --post after. Exit code is the verdict.
`;

async function main(argv) {
  const opts = parseArgs(argv || []);
  if (opts.error) {
    console.error("signoff release: " + opts.error);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = findRoot();
  if (!root) {
    console.error("signoff release: no package.json above the working directory");
    return 2;
  }
  const pkg = readJson(path.join(root, "package.json"));
  const serverPath = path.join(root, "server.json");
  const hasServer = fs.existsSync(serverPath);
  const server = hasServer ? readJson(serverPath) : null;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: detail || "" });

  // ---- manifests -----------------------------------------------------------
  add("manifest-name", NPM_NAME.test(pkg.name || ""), pkg.name || "missing");
  add("manifest-version", SEMVER.test(pkg.version || ""), pkg.version || "missing");
  const binRel = pkg.bin && (typeof pkg.bin === "string" ? pkg.bin : pkg.bin.signoff);
  add("manifest-bin", !!binRel && fs.existsSync(path.join(root, binRel)), binRel || "no signoff bin");
  if (Array.isArray(pkg.files)) {
    const norm = pkg.files.map((f) => String(f).replace(/\/+$/, ""));
    add("manifest-files", norm.includes("bin") && norm.includes("lib"), pkg.files.join(","));
  }
  if (hasServer) {
    add("server-version", server.version === pkg.version, server.version + " vs " + pkg.version);
    const pkgs = Array.isArray(server.packages) ? server.packages : [];
    add("server-package-version", pkgs.length > 0 && pkgs.every((p) => p.version === pkg.version), pkgs.map((p) => p.version).join(",") || "none");
    add("server-package-name", pkgs.length > 0 && pkgs.every((p) => p.identifier === pkg.name), pkgs.map((p) => p.identifier).join(",") || "none");
    add("server-mcpname", !pkg.mcpName || server.name === pkg.mcpName, (server.name || "") + " vs " + (pkg.mcpName || "none"));
    const repoUrl = pkg.repository && (pkg.repository.url || pkg.repository);
    const srvUrl = server.repository && server.repository.url;
    add("server-repo", !repoUrl || !srvUrl || String(repoUrl).replace(/\.git$/, "") === String(srvUrl).replace(/\.git$/, ""), (srvUrl || "") + " vs " + (repoUrl || ""));
  }

  // ---- artifact ------------------------------------------------------------
  let tmpDir = null;
  if (opts.pre) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signoff-release-"));
    const packed = run(npmCmd(), ["pack", "--json", "--pack-destination", tmpDir], { cwd: root });
    let tgz = null;
    try {
      const info = JSON.parse(packed.out)[0];
      tgz = path.join(tmpDir, info.filename);
    } catch (e) {
      tgz = null;
    }
    const tarballOk = !!tgz && fs.existsSync(tgz) && fs.statSync(tgz).size > 1000;
    add("pack", tarballOk, tarballOk ? path.basename(tgz) + " " + fs.statSync(tgz).size + "B" : (packed.err || packed.out || "npm pack failed").slice(0, 200));

    if (tarballOk) {
      const list = run("tar", ["-tzf", tgz]);
      if (list.ok) {
        const entries = list.out.split(/\r?\n/).filter(Boolean);
        const need = [binRel, "lib/", "package.json"].filter(Boolean);
        const missing = need.filter((n) => !entries.some((e) => e.replace(/^package\//, "").startsWith(n)));
        add("tarball-entries", missing.length === 0, missing.length ? "missing: " + missing.join(",") : entries.length + " entries");
      }

      const proj = path.join(tmpDir, "proj");
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "release-probe", version: "0.0.0", private: true }));
      const inst = run(npmCmd(), ["install", tgz, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: proj });
      const pkgDir = path.join(proj, "node_modules", pkg.name);
      const installedBin = binRel ? path.join(pkgDir, binRel) : null;
      const hasBin = !!installedBin && fs.existsSync(installedBin);
      add("install", !!inst.ok && hasBin, inst.ok ? (hasBin ? "installed" : "bin missing after install") : (inst.err || "npm install failed").slice(0, 200));

      if (inst.ok && hasBin) {
        const v = spawnSync(process.execPath, [installedBin, "--version"], { encoding: "utf8", timeout: 60000 });
        const got = (v.stdout || "").trim();
        add("installed-version", got === pkg.version, "got=" + (got || "(empty)") + " want=" + pkg.version);
        const hs = await mcpHandshake(installedBin, 8000);
        add("installed-mcp", hs.ok, hs.detail);
      }
    }
    if (!opts.keep && tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* temp */ }
    }
  }

  // ---- published facts -----------------------------------------------------
  if (opts.post) {
    const npmRes = await httpGet("https://registry.npmjs.org/" + encodeURIComponent(pkg.name).replace("%40", "@"), 20000);
    let npmDoc = null;
    try { npmDoc = JSON.parse(npmRes.body); } catch (e) { npmDoc = null; }
    add("npm-reachable", !!npmDoc, npmDoc ? "ok" : "status " + npmRes.status);
    if (npmDoc) {
      const latest = (npmDoc["dist-tags"] || {}).latest;
      add("npm-latest", latest === pkg.version, "latest=" + latest + " want=" + pkg.version);
      add("npm-has-version", !!(npmDoc.versions || {})[pkg.version], pkg.version);
    }

    if (hasServer) {
      const reg = await httpGet("https://registry.modelcontextprotocol.io/v0/servers?search=" + encodeURIComponent(server.name) + "&limit=100", 25000);
      let doc = null;
      try { doc = JSON.parse(reg.body); } catch (e) { doc = null; }
      add("registry-reachable", !!doc, doc ? "ok" : "status " + reg.status);
      if (doc) {
        const rows = (doc.servers || []).filter((s) => (s.server || s).name === server.name);
        const mine = rows.find((s) => {
          const meta = (s._meta || {})["io.modelcontextprotocol.registry/official"] || {};
          return meta.isLatest;
        });
        const latestVersion = mine ? mine.server.version : null;
        add("registry-latest", latestVersion === pkg.version, "latest=" + (latestVersion || "none") + " want=" + pkg.version);
        if (mine) {
          const p0 = (mine.server.packages || [])[0] || {};
          add("registry-package-version", p0.version === pkg.version, p0.version + " vs " + pkg.version);
        }
      }
    }

    // Every image in the README is served from raw.githubusercontent; after a rename
    // these are the links that silently rot on the npm page.
    const readmePath = path.join(root, "README.md");
    if (fs.existsSync(readmePath)) {
      const text = fs.readFileSync(readmePath, "utf8");
      const urls = [...text.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^\s)"']+/g)].map((m) => m[0]);
      const uniq = [...new Set(urls)];
      let bad = [];
      for (const u of uniq) {
        const r = await httpGet(u, 20000);
        if (r.status !== 200) bad.push(u.replace("https://raw.githubusercontent.com/", "") + " " + r.status);
      }
      add("readme-links", bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : uniq.length + " links ok");
    }
  }

  const failed = checks.filter((c) => !c.ok);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, version: pkg.version, name: pkg.name, checks, kept: opts.keep ? tmpDir : null }, null, 2) + "\n");
  } else {
    for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(22)} ${c.detail}`);
    console.log(`[release] ${failed.length ? "FAIL" : "PASS"} ${checks.length - failed.length}/${checks.length} checks (${pkg.name}@${pkg.version})`);
    if (opts.keep && tmpDir) console.log("[release] kept " + tmpDir);
  }
  return failed.length ? 1 : 0;
}

module.exports = { main, mcpHandshake };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
