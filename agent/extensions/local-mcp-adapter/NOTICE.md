# Local MCP adapter notice

This extension is a local, simplified implementation for Pi MCP access. Its design intentionally borrows the main ideas from `nicobailon/pi-mcp-adapter`: use a small proxy tool instead of registering every MCP tool, read common MCP config files, lazy-connect servers, cache discovered tool metadata, and close server transports on session shutdown.

No remote package is loaded at runtime. The upstream project is MIT licensed; keep the upstream MIT license terms in mind if future edits copy substantial code rather than just ideas.
