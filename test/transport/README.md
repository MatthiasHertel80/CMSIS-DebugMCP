# Transport harness

Drives the real `DebugMCPServer` over HTTP outside the extension host, with a
stubbed `vscode` module (`vscode-stub.js`, injected via a `Module._resolveFilename`
override). No board and no VS Code required.

```sh
npm run compile
node test/transport/session-lifecycle.js
```

Exits non-zero on the first failed check.

## What `session-lifecycle.js` covers

- `POST /mcp` with an `initialize` request mints an `mcp-session-id`.
- `GET /mcp` carrying that id returns a live `text/event-stream`.
- `GET /mcp` with a missing or unknown id is rejected with **400**, not a bare
  404. This is the regression that made Cursor's MCP client tombstone the
  connection as "errored" while POST tool calls kept working.
- `tools/list` returns the full tool surface.
- **Three consecutive `get_threads` calls on one session all return.** This is
  the load-bearing check. The server originally shared one `McpServer` across
  requests and closed it per request, so a concurrent call stripped the other's
  transport and its response went nowhere — `get_threads` hung after the third
  call. The fix was per-request servers; moving to per-*session* servers (needed
  for the SSE stream and for routing) must not bring the hang back.
- `DELETE /mcp` tears the session down, and a `GET` after it is rejected.

Belongs here rather than in `src/test/` because it needs a real listening
socket, which the `vscode-test` Electron harness does not give us.
