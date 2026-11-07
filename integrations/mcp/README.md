# SignOff as an MCP server

`integrations/mcp/server.js` is a dependency-free stdio MCP server that exposes the
`signoff` CLI as tools, so any MCP client (Claude Desktop, DSH, an IDE) can run the
gates without shelling out by hand.

```jsonc
// claude_desktop_config.json / DSH MCP entry
{
  "mcpServers": {
    "signoff": {
      "command": "node",
      "args": ["E:/path/to/signoff-cli/integrations/mcp/server.js"]
    }
  }
}
```

Tools: `signoff_run`, `signoff_status`, `signoff_doctor`, `signoff_audit`, `signoff_explain`.
Each returns `exit N` plus the combined output; `isError` mirrors the exit code, because in
SignOff the exit code *is* the verdict.

Smoke test without an MCP client:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node integrations/mcp/server.js
```


`signoff release --pre|--post` guards the artifact itself: it packs the tarball, installs it into a
temporary directory, runs `--version`, and completes an `mcp` initialize handshake (`--post` then checks
npm, the registry entry and README links). Since 4.1.2 `integrations/` ships inside the npm package, so
`signoff mcp` works from any installed copy - before that it was `MODULE_NOT_FOUND`.
