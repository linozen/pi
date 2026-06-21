# Local MCP Adapter for Pi

Local Pi extension that exposes configured MCP servers through one token-light `mcp` proxy tool.

## Config files

The extension reads these files in order; later files override earlier files:

1. `~/.config/mcp/mcp.json`
2. `~/.pi/agent/mcp.json`
3. `.mcp.json` in the current project
4. `.pi/mcp.json` in the current project

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

`args` is a JSON string. Servers are lazy by default and disconnect after 10 idle minutes unless `idleTimeout` or `lifecycle` changes that behavior.

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

Tokens are stored in `~/.pi/agent/mcp-oauth.json`. Clear them with:

```text
mcp({ "action": "auth-clear", "server": "linear-server" })
```

## Scope

This is intentionally smaller than `pi-mcp-adapter`: no setup UI, sampling, elicitation, MCP resources-as-tools, direct tool registration, or app bridge UI. It keeps the central path local and reviewable: config loading, lazy MCP connections, OAuth for HTTP servers, metadata cache, proxy discovery, proxy calls, and shutdown cleanup.
