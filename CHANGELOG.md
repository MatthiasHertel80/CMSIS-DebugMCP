# Changelog

All notable changes to CMSIS-DebugMCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.27] - 2026-05-18

First public release of the fork. Rolls up the work between v1.0.9 (initial CMSIS fork tag) and v1.0.27 into one release. Published as a GitHub release with `cmsis-debugmcp-1.0.27.vsix` attached.

### Added — CMSIS-Solution-driven workflow
- **`cmsis_action` MCP tool**: wraps the CMSIS Solution panel buttons. Actions: `build`, `load`, `erase`, `load_and_run`, `load_and_debug`, `attach`, `detach`, `stop_run`. **Preferred entry point for Cortex-M debug** over `start_debugging` — `load_and_debug` builds (if needed), flashes the device, and attaches the debugger in one step, matching the panel's "Debug" button. `load_and_debug` and `attach` wait for the session to be usable before returning.
- **Pre-check refusal on duplicate session**: `start_debugging`, `cmsis_action load_and_debug`, and `cmsis_action attach` now refuse with a structured message when a debug session is already active, naming the existing session and pointing the agent at `stop_debugging` / `restart_debugging`.
- **`start_debugging` re-scoped**: tool description rewritten to flag it as **non-CMSIS only** (Python / Java / JS / etc.). For CMSIS projects, `cmsis_action load_and_debug` is the right call.

### Added — Pause, call-stack, threads, frame variables
- **`pause_execution` MCP tool**: DAP `pause` for inspecting a running target without ending the session. State-aware: no-op if already stopped, refuses if probe is unresponsive.
- **`get_call_stack` MCP tool**: full DAP `stackTrace` with frame IDs (up to 200 levels). Agent can walk the stack and pass `frameId` to `get_frame_variables`.
- **`get_threads` MCP tool**: DAP `threads` enumeration. With RTOS-aware GDB servers (pyOCD `--rtos`, J-Link RTOS plugin), FreeRTOS / RTX / ThreadX tasks appear as threads — matching the xRTOS viewer task list.
- **`get_frame_variables` MCP tool**: inspect variables at an explicit `frameId` without changing the editor's active frame. Lets the agent walk up the call stack and examine caller-frame state.

### Added — Per-call timeouts and auto-heal
- **`timeoutMs` parameter on every hardware-touching tool**: agent-supplied deadline, server-capped to 60 000 ms regardless of input.
- **Handler-level `withHandlerTimeout` race**: every inspection tool is wrapped in an outer Promise.race so it always returns within the cap, even if the DAP layer hangs. On overshoot, returns a structured "did not complete within N ms" message with diagnostic guidance.
- **Auto-heal on motion timeout**: `continue_execution` / `step_*` automatically pause the running target on overshoot, read the PC + active frame via `read_core_registers`, and append a 🩹 Recovery section to the response — the agent knows where the firmware actually was instead of seeing a silent "still running".

### Added — Dual serial backend
- **OWNED port** via `serialport` package: `serial_open` / `serial_close` / `serial_write` / `serial_read` (from `'owned'`) / `serial_clear_buffer` / `serial_list_ports` / `serial_status`. MCP server holds the connection and buffers RX up to 1 MB. Use when no MS Serial Monitor UI session is active on the same tty.
- **MS Serial Monitor BRIDGE**: `serial_subscribe_monitor` / `serial_unsubscribe_monitor` runtime-probe `ms-vscode.vscode-serial-monitor` exports for any of `onDidReceiveData` / `onDataReceived` / `onData` / `onSerialData` / `onDidReadData` / `subscribeData`. Today the public API (v0.1.7) only exposes port enumeration; the bridge falls back with a clear "data event not available" message. Auto-lights-up when MS ships a data event — no rebuild needed.
- **`serial_status`**: reports both backends side-by-side and lists the discovered `ext.exports` keys so the agent can confirm what the installed Serial Monitor build exposes.
- **`serial_open_monitor`**: focuses the MS Serial Monitor panel for the user (does not open or read a port). Uses the correct view container ID `vscode-serial-monitor-tools`.

### Added — Stateless HTTP transport (concurrency fix)
- **Per-request `McpServer` instances**: the previous shared-server pattern (`close()` → `connect(newTransport)` on every POST) raced when two tool calls landed concurrently — request B's `close()` stripped the transport request A was about to respond on, hanging request A forever. Now each POST to `/mcp` constructs its own `McpServer` + transport pair and registers tools fresh, matching the official MCP stateless example. Eliminates the `get_threads`-after-three-calls hang.

### Added — Hardware-connection robustness
- **DAP-event-driven session state**: a global `DebugAdapterTrackerFactory` records `stopped` and `continued` events per session. `hasActiveSession()` and `get_session_status` consult this tracker instead of `vscode.debug.activeStackItem`, which is `undefined` whenever the CPU is running and during the brief race window right after a stop event. Eliminates spurious "session is not ready" / "no debug session" reports while the target is just running.
- **`get_session_status` MCP tool**: never-failing classification of the session into `no-session` / `initializing` / `running` / `stopped` / `unresponsive`, with a hint about what to do next.
- **State-aware inspection errors**: inspection tools (`get_variables_values`, `evaluate_expression`, `read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`) route through `ensureStoppedSession` and report the actual session state ("running — add a breakpoint", "unresponsive — call check_target_connection") instead of a misleading "no debug session".
- **Per-DAP-request timeouts**: every `customRequest` to the debug adapter is wrapped with a deadline. A stalled probe cannot hang an MCP tool call indefinitely.
- **`HardwareTimeoutError`**: dedicated error type with actionable message.
- **`check_target_connection` MCP tool**: low-cost DAP `threads` ping with a short internal timeout. Diagnostic-grade liveness check.
- **`hasDebugSession()` / `hasActiveSession()` split**: synchronous session-existence check (for `stop_debugging` / `restart_debugging`, works even when target is running) vs. async stopped-frame check (for inspection tools).
- **Parallel core-register reads**: `read_core_registers` issues all 23 evaluates concurrently with per-request and overall deadlines. Individual register failures report `<timeout>` / `<unavailable>` instead of bringing down the whole call.
- **Bounded `read_memory`** and **`read_peripheral_register`**: total time per call capped by `memoryReadTimeoutMs`.
- **`restart_debugging` actually waits** for the session to become ready again, rather than returning after a fixed 300 ms delay.
- **`step_*` / `continue_execution` surface timeouts and session loss**: results annotate when the target failed to stop within the timeout or when the session terminated mid-operation, instead of silently returning a stale state.

### Added — Agent guidance (`debug_instructions.md`)
- **PHASE 0 — Target awareness**: agent reads `<name>.cbuild-idx.yml` → `<context>.cbuild.yml` → `<context>.cbuild-run.yml` → `.vscode/launch.json` before any debug call, and asks the user to regenerate `launch.json` via **Manage Solution → Debugger** if missing. Pointers to CMSIS-Pack documentation links from the CMSIS Solution dialog.
- **PHASE 1 — Session status gate**: 5-state decision table for `get_session_status`, telling the agent the correct next action for each (`no-session` → `cmsis_action load_and_debug`; `running` → pause first; `unresponsive` → `check_target_connection`).
- **Cortex-M hardware breakpoint limit**: documents the FPB comparator ceiling (M0/M0+/M23: 4, M3/M4: 6, M7/M33/M55/M85: 8) and recommends `list_breakpoints` before adding, iterative replacement, and `clear_all_breakpoints` between phases.

### Added — Real-board test driver
- **`test/realboard/run.ts`**: end-to-end test runner that connects to the running MCP server (Streamable HTTP) and exercises every tool. Pre-flight `estimatedMs` per test; hard timeout `min(2 × estimatedMs, 60 s)`; pauses and runs a diagnostic sweep (`get_session_status` / `check_target_connection` / `get_fault_info`) on every overshoot. Board-specific knobs (endpoint, configurationName, ELF region, peripheral name, serial path) come from `realboard.config.json`.

### Configuration
- **`cmsis-debugmcp.dapRequestTimeoutMs`** (default 10000) — per-request DAP timeout.
- **`cmsis-debugmcp.memoryReadTimeoutMs`** (default 30000) — overall cap for `read_memory` / `read_core_registers`.

### Removed
- **Static `mcp.json` write for GitHub Copilot**: superseded by the `vscode.lm.registerMcpServerDefinitionProvider` registration done at extension activation, which eliminates the startup race condition and handles dynamic port assignment automatically. Cline and Cursor static configs are still written.

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