# Local MCP Adapter for Pi

Local Pi extension that exposes configured MCP servers through one token-light `mcp` proxy tool.

## Config files

The extension reads these files in order; later files override earlier files:

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `.mcp.json` in the current project
4. `.pi/mcp.json` in the current project

Project files are loaded only after explicit Pi project trust. In untrusted projects they are not parsed or executed; `/mcp` and `mcp({ "action": "status" })` report any skipped project config paths. Cached tool metadata is accepted only when the current server definition matches the definition that produced it.

Pi's built-in trust prompt does not currently treat `.mcp.json` or `.pi/mcp.json` alone as trust-requiring resources. For a project containing only those files, run `/trust`, save a trust decision, and restart Pi before its MCP config can load. Projects that already trigger native Pi trust continue to honor that session's trust decision and CLI override.

Example:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "lifecycle": "lazy"
    }
  }
}
```

## Usage

Ask Pi to use the `mcp` tool, or call it directly in prompts:

```text
mcp({ "action": "status" })
mcp({ "action": "search", "query": "screenshot" })
mcp({ "action": "describe", "tool": "chrome_devtools_take_screenshot" })
mcp({ "action": "call", "tool": "chrome_devtools_take_screenshot", "args": "{\"format\":\"png\"}" })
```

`args` is a JSON string. Servers are lazy by default and disconnect after 10 idle minutes after first use unless `idleTimeout` changes that behavior. Set `lifecycle` explicitly when needed:

- `lazy` or omitted — connect only on an explicit list/connect/refresh/call that needs the server.
- `eager` — connect at session startup, then use idle cleanup.
- `keep-alive` — connect at session startup and remain connected until shutdown.

After editing MCP config or restarting a server, reload config and tool metadata without reloading Pi:

```text
/refresh-mcp
/refresh-mcp chrome-devtools
```

The optional argument refreshes only the named server. `/mcp` shows current adapter status.

## Output and errors

MCP text, image payloads, and structured output are bounded to Pi's 50KB/2,000-line tool limit. When output exceeds either limit, the complete raw result is written to a mode-0600 temporary artifact, its path is returned with the truncated result, and the artifact is removed at session shutdown.

Transport failures, invalid calls, refresh failures, and MCP results marked `isError` are thrown as failed Pi tool executions rather than returned as successful results.

## OAuth HTTP servers

HTTP servers use MCP SDK OAuth support unless `auth` is explicitly `false`. For Linear:

```json
{
  "mcpServers": {
    "linear-server": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

Start auth:

```text
mcp({ "action": "auth-start", "server": "linear-server" })
```

Open the returned URL. After Linear redirects to localhost, copy the full browser address and complete auth:

```text
mcp({ "action": "auth-complete", "server": "linear-server", "args": "{\"redirectUrl\":\"PASTE_REDIRECT_URL_HERE\"}" })
```

Tokens are stored in `~/.pi/agent/mcp-oauth.json`, bound to the server URL and OAuth client configuration that issued them. OAuth completion requires the returned state value and consumes it once. Clear credentials with:

```text
mcp({ "action": "auth-clear", "server": "linear-server" })
```

## Scope

This is intentionally smaller than `pi-mcp-adapter`: no setup UI, sampling, elicitation, MCP resources-as-tools, direct tool registration, or app bridge UI. It keeps the central path local and reviewable: config loading, lazy MCP connections, OAuth for HTTP servers, metadata cache, proxy discovery, proxy calls, and shutdown cleanup.
