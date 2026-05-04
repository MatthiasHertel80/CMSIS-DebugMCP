# Changelog

All notable changes to CMSIS-DebugMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Hardware-connection robustness
- **DAP-event-driven session state**: a global `DebugAdapterTrackerFactory` records `stopped` and `continued` events per session. `hasActiveSession()` and `get_session_status` now consult this tracker instead of relying on `vscode.debug.activeStackItem`, which is `undefined` whenever the CPU is running and during the brief race window right after a stop event. Eliminates spurious "session is not ready" / "no debug session" reports while the target is just running.
- **`get_session_status` MCP tool**: never-failing classification of the session into `no-session` / `initializing` / `running` / `stopped` / `unresponsive`, with a hint about what to do next. The agent's first port of call when it is unsure whether a session is alive.
- **Actionable readiness errors**: step/continue gates no longer throw the vague "Debug session is not ready" message. They now report the actual session state ("running — add a breakpoint", "unresponsive — call check_target_connection", etc.) and point the agent at `get_session_status`.
- **Per-DAP-request timeouts**: every `customRequest` to the debug adapter (stackTrace, evaluate, scopes, variables, readMemory, register reads, threads, step/continue) is now wrapped with a deadline. A stalled probe or GDB server can no longer hang an MCP tool call indefinitely.
- **`HardwareTimeoutError`**: dedicated error type with an actionable message ("probe or target may be unresponsive — check the physical connection, reset the target, or restart the debug session").
- **New `check_target_connection` MCP tool**: low-cost DAP `threads` ping with a short internal timeout. Use this when other tools start timing out to determine whether the probe is alive and whether the target is in a stopped state.
- **Lightweight `hasActiveSession()` gate**: replaces the previous full `stackTrace`-based readiness probe with a short-deadline `threads` request plus the DAP-event tracker. Keeps the per-tool gate fast on healthy probes and bounded on hung ones.
- **Synchronous `hasDebugSession()`**: zero-DAP existence check, used by `stop_debugging` and `restart_debugging` so they work even when the target is running or the probe is hung.
- **Parallel core-register reads**: `read_core_registers` now issues all 23 register evaluates concurrently with per-request and overall deadlines. Individual register failures (including timeouts) report `<timeout>`/`<unavailable>` instead of bringing down the whole call.
- **Bounded `read_memory`**: total time for a single `read_memory` call (including the per-word GDB fallback loop) is capped by `memoryReadTimeoutMs`.
- **Restart actually waits**: `restart_debugging` now waits for the session to become ready again (using the same exponential-backoff probe as `start_debugging`) rather than returning after a fixed 300 ms delay.
- **Step/continue surface timeouts and session loss**: results of `step_*` and `continue_execution` annotate when the target failed to stop within the timeout or when the debug session terminated mid-operation, instead of silently returning a stale state.
- **New configuration**:
  - `cmsis-debugmcp.dapRequestTimeoutMs` (default 10000) — per-request DAP timeout.
  - `cmsis-debugmcp.memoryReadTimeoutMs` (default 30000) — overall cap for `read_memory` / `read_core_registers`.

## [1.0.9] - 2026-04-16

### Added — CMSIS-DebugMCP fork
- **Project rename**: `DebugMCP` → `CMSIS-DebugMCP`. Extension name, display name, MCP server name, resource URIs (`cmsis-debugmcp://docs/...`), configuration keys (`cmsis-debugmcp.*`), and command IDs updated.
- **`gdbtarget` passthrough**: when `start_debugging` is called with `configurationName`, the named entry from `launch.json` is passed directly to `vscode.debug.startDebugging()` without language detection or config rewriting. `fileFullPath` is now optional in this path.
- **Five new embedded MCP tools**: `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, `get_device_info`.
- **Cortex-M fault decoder**: decodes CFSR (MMFSR/BFSR/UFSR), HFSR, DFSR, MMFAR, BFAR, AFSR into human-readable diagnostics.
- **Peripheral register reader**: uses the Peripheral Inspector extension API when available; falls back to SVD parsing + DAP `readMemory`.
- **CMSIS knowledge resources**: `cmsis-debugmcp://docs/cmsis-embedded-guide` and `cmsis-debugmcp://docs/troubleshooting/embedded` provide Cortex-M expertise to agents.

### Upstream history (DebugMCP)

## [1.0.8] - 2025-03-14

### Added
- Improved debug state reporting with richer context for AI agents
- Named debug configuration support via `configurationName` parameter — use specific `launch.json` configurations by name

### Fixed
- Fixed debug state consistency issues during rapid step operations

## [1.0.7] - 2025-02-XX

### Changed
- **Migrated from SSE to Streamable HTTP transport** — faster, more reliable MCP communication
- Automatic migration of existing SSE configurations to new Streamable HTTP format
- SSE backward compatibility maintained during transition period

### Fixed
- Dependency security updates (undici, express, body-parser, glob, js-yaml)

### Internal
- Migrated from `fastmcp` to official `@modelcontextprotocol/sdk`

## [1.0.6] - 2025-01-XX

### Added
- **Agent auto-configuration popup** — automatically detects and registers with AI assistants (Cline, Copilot, Cursor)
- **Comprehensive documentation** — added architecture docs, AGENTS.md, and troubleshooting guides
- Language-specific debugging tips for Python, JavaScript, Java, C#, C++, and Go

### Fixed
- Fixed failure when `launch.json` contains comments (JSONC parsing)
- Fixed C++ debug configuration issues
- Fixed string equality comparison in breakpoint matching

## [1.0.5] - 2025-01-XX

### Added
- **Debug specific test methods** — pass `testName` to debug individual unit tests
- Clear all breakpoints tool for quick cleanup
- Breakpoint listing tool to view all active breakpoints

### Changed
- Default launch configurations moved to lower priority (user configs preferred)
- Improved MCP tool descriptions for better AI agent understanding

## [1.0.4] - 2024-12-XX

### Added
- **C#/.NET debugging support**
- Keep-alive for SSE sessions to prevent timeouts

## [1.0.3] - 2024-12-XX

### Added
- Multi-language debugging support: Python, JavaScript/TypeScript, Java, C/C++, Go, Rust, PHP, Ruby
- Breakpoint management (add, remove, list, clear all)
- Step-through execution (step over, step into, step out)
- Variable inspection with scope filtering (local, global, all)
- Expression evaluation in debug context
- Automatic debug configuration generation from file extensions
- MCP server with SSE transport

## [1.0.0] - 2024-12-XX

### Added
- Initial release
- Core debugging capabilities via MCP protocol
- VS Code Debug Adapter Protocol integration
- Automatic MCP server startup on extension activation