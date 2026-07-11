# CMSIS-DebugMCP — AI-Driven Debugging for Arm Cortex-M Targets

CMSIS-DebugMCP is an MCP server that lets an AI agent drive the VS Code debugger against Arm Cortex-M targets through the **CMSIS Debugger** extension — setting breakpoints, stepping, reading memory and core registers, decoding fault status, and inspecting peripheral registers via SVD. It also retains general multi-language debugging support (Python, JavaScript/TypeScript, Java, C#, C++, Go, Rust, PHP, Ruby) inherited from the upstream DebugMCP project.

Works with **GitHub Copilot**, **Claude Code**, **Claude Desktop**, **Cline**, **Cursor**, and any MCP-compatible assistant.

> This project is a fork of [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) extended for Arm embedded workflows. See [CHANGELOG.md](CHANGELOG.md) for the list of embedded-specific additions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](https://github.com/MatthiasHertel80/CMSIS-DebugMCP/releases)

<p align="center">
  <img src="assets/DebugMCP.webp" alt="CMSIS-DebugMCP Demo" width="800">
</p>

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Quick Start — CMSIS Target](#quick-start--cmsis-target)
- [Supported Languages](#supported-languages)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

CMSIS-DebugMCP is an MCP server that gives AI coding agents full control over the VS Code debugger. For embedded Arm Cortex-M development it delegates to the **CMSIS Debugger** extension (`arm.vscode-cmsis-debugger`) via `gdbtarget` launch configurations produced by CMSIS Solution, driving pyOCD or J-Link GDB Server against real hardware such as the Alif Semiconductor AppKit. It also retains the upstream DebugMCP behavior for general multi-language debugging. It runs 100% locally, requires no credentials, and works out of the box with any MCP-compatible AI assistant.

## Features

> Every hardware-touching tool accepts an optional **`timeoutMs`** parameter (server-capped to 60 000 ms). Handler-level deadlines guarantee no MCP call hangs the agent — see *Operational guarantees* below.

### ⭐ CMSIS Solution control (preferred for embedded)

| Tool | Description | Parameters |
|------|-------------|------------|
| **cmsis_action** | Wrap the buttons in the CMSIS Solution panel. ⭐ Preferred entry point for Cortex-M debug — `load_and_debug` builds (if needed), flashes the device, and attaches in one step. | `action` (`build` / `load` / `erase` / `load_and_run` / `load_and_debug` / `attach` / `detach` / `stop_run`)<br>`timeoutMs` (optional) |

### 🔧 Core Debug Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **get_debug_instructions** | Get the debugging guide with best practices, target-awareness checklist, session-status decision table, and root-cause framework | None |
| **start_debugging** | Start a debug session (non-CMSIS targets — Python/Java/JS/etc.). For CMSIS use `cmsis_action load_and_debug` instead. Refuses if a session is already active. | `configurationName` (optional)<br>`fileFullPath` (optional)<br>`workingDirectory` (optional)<br>`testName` (optional)<br>`timeoutMs` (optional) |
| **stop_debugging** | Stop the current debug session | None |
| **restart_debugging** | Restart the current debug session and wait for it to become ready | `timeoutMs` (optional) |
| **pause_execution** | DAP `pause` — halt a running target without ending the session. No-op if already stopped. | `timeoutMs` (optional) |
| **step_over** / **step_into** / **step_out** | Step. Auto-heals on timeout: pauses the running target, reads PC + frame, reports where the firmware actually was. | `timeoutMs` (optional) |
| **continue_execution** | Resume execution. Same auto-heal-on-timeout behavior. | `timeoutMs` (optional) |
| **add_breakpoint** | Add a breakpoint at a specific line. State-aware hint when the session is running. | `fileFullPath`<br>`lineContent` |
| **remove_breakpoint** | Remove a breakpoint | `fileFullPath`<br>`line` |
| **clear_all_breakpoints** / **list_breakpoints** | Breakpoint set management | None |
| **get_variables_values** | Variables at the active frame | `scope` (`local` / `global` / `all`)<br>`timeoutMs` (optional) |
| **evaluate_expression** | Evaluate an expression in the current frame | `expression`<br>`timeoutMs` (optional) |
| **get_call_stack** | Full DAP stackTrace with `frameId` per frame | `threadId` (optional)<br>`levels` (optional, ≤200)<br>`timeoutMs` (optional) |
| **get_threads** | DAP threads enumeration. With RTOS-aware GDB servers (pyOCD `--rtos`, J-Link plugin) returns FreeRTOS / RTX / ThreadX tasks. | `timeoutMs` (optional) |
| **get_frame_variables** | Inspect variables at an explicit `frameId` without changing the active editor frame | `frameId`<br>`scope` (optional)<br>`timeoutMs` (optional) |

### 🧠 Embedded / Cortex-M Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **read_memory** | Read a range of bytes from the target. DAP `readMemory` with multi-strategy GDB fallback. | `address` (hex)<br>`length` (1-4096)<br>`format` (`hex` / `ascii` / `both`)<br>`timeoutMs` (optional) |
| **read_core_registers** | Read Cortex-M core registers (R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK). Parallel evaluates with overall and per-request deadlines. | `timeoutMs` (optional) |
| **read_peripheral_register** | Read peripheral registers using SVD definitions (via Peripheral Inspector or SVD fallback) | `peripheral`<br>`register` (optional)<br>`timeoutMs` (optional) |
| **get_fault_info** | Read and decode CFSR / HFSR / DFSR / MMFAR / BFAR / AFSR for HardFault analysis | `timeoutMs` (optional) |
| **get_device_info** | Return session info: device, probe, processor, GDB server, ports, cbuild-run reference | None |

### 🩺 Session health

| Tool | Description |
|------|-------------|
| **get_session_status** | Never-throwing 5-state classifier (`no-session` / `initializing` / `running` / `stopped` / `unresponsive`) with hint per state |
| **check_target_connection** | Low-cost DAP `threads` ping with short internal timeout — diagnostic-grade liveness check |

### 📟 Serial (dual backend)

| Tool | Backend | Description |
|------|---------|-------------|
| **serial_list_ports** | API → fallback | List ports (MS Serial Monitor API → bundled `serialport`) |
| **serial_open** / **serial_close** / **serial_write** / **serial_read** (`from='owned'`) / **serial_status** / **serial_clear_buffer** | OWNED | MCP server owns the connection via `serialport`. Use when no MS Serial Monitor session holds the same tty. |
| **serial_subscribe_monitor** / **serial_unsubscribe_monitor** / **serial_read** (`from='monitor'`) | BRIDGE | Runtime-probe the MS Serial Monitor extension for any of `onDidReceiveData` / `onDataReceived` / `onData` / `onSerialData` / `onDidReadData` / `subscribeData`. Today's API (v0.1.7) only exposes port enumeration; auto-lights-up when MS ships a data event. |
| **serial_open_monitor** | UI | Focus the Microsoft Serial Monitor panel for the user (does not connect a port). |

### 📚 MCP Resources

- `cmsis-debugmcp://docs/debug_instructions` — general debugging workflow guide
- `cmsis-debugmcp://docs/cmsis-embedded-guide` — Cortex-M debugging expertise (fault decode recipes, memory map, key system registers, RTOS tips)
- `cmsis-debugmcp://docs/troubleshooting/embedded` — embedded-specific troubleshooting
- `cmsis-debugmcp://docs/troubleshooting/<language>` — language-specific troubleshooting (python, java, csharp, …)

> **Note:** The `get_debug_instructions` tool is particularly useful for AI clients like GitHub Copilot that don't support MCP resources. It provides the same debugging guide content that is also available as an MCP resource.

### 🎯 Debugging Best Practices

CMSIS-DebugMCP follows systematic debugging practices for effective issue resolution:

- **Start with Entry Points**: Begin debugging at function entry points or main execution paths
- **Follow the Execution Flow**: Use step-by-step execution to understand code flow
- **Root Cause Analysis**: Don't stop at symptoms - find the underlying cause

### 🛡️ Operational guarantees

These are engineering invariants the agent can rely on — see [CHANGES-VS-UPSTREAM.md §5](CHANGES-VS-UPSTREAM.md) for the source-level detail.

- **No MCP tool call exceeds 60 s.** Every hardware-touching handler is wrapped in a handler-level `Promise.race` against a deadline. Server-supplied cap clamps any agent-supplied `timeoutMs` to ≤60 000 ms.
- **No DAP request hangs the call.** Every `customRequest` goes through `customRequestWithTimeout` and rejects with `HardwareTimeoutError` past its deadline.
- **Inspection tools never lie about state.** If the target is running, the call returns a state-aware error pointing at the correct recovery tool (`pause_execution` / `add_breakpoint` / `continue_execution`) — not a misleading "no debug session".
- **Concurrent tool calls don't trample each other.** Per-request `McpServer` + transport pair (matches the official MCP stateless example), eliminating the shared-server race.
- **Motion timeouts always produce actionable output.** `continue_execution` / `step_*` auto-heal: on overshoot they pause the target, read PC + active frame, and tell you where the firmware actually was.
- **`start_debugging` / `cmsis_action load_and_debug` refuse duplicates** with a structured message naming the existing session.
- **Local & credential-free.** The MCP server runs 100% on localhost; nothing leaves the machine.

## Installation

### From the GitHub release (recommended)

Download the latest `cmsis-debugmcp-<version>.vsix` from <https://github.com/MatthiasHertel80/CMSIS-DebugMCP/releases>, then:

```bash
code --install-extension cmsis-debugmcp-1.0.27.vsix
```

Reload the VS Code window after install. Copilot picks the server up automatically via the registered `McpServerDefinitionProvider` — no `mcp.json` edits required.

### From source

```bash
git clone https://github.com/MatthiasHertel80/CMSIS-DebugMCP.git
cd CMSIS-DebugMCP
npm install
npm run compile
npx --yes @vscode/vsce package
code --install-extension cmsis-debugmcp-1.0.27.vsix
```

The extension activates on startup and registers an MCP server on `http://localhost:3001/mcp` by default (falls back to an OS-assigned port if 3001 is busy — the dynamic discovery handles this for Copilot).

### Recommended companion extensions

For embedded Arm Cortex-M workflows, install the following alongside CMSIS-DebugMCP:

- **Arm CMSIS Debugger** (`arm.vscode-cmsis-debugger`) — provides the `gdbtarget` launch configuration provider and ships pyOCD.
- **CDT GDB Debug Adapter** (`eclipse-cdt.cdt-gdb-vscode`) — DAP-to-GDB-MI adapter used by `gdbtarget` sessions.
- **Peripheral Inspector** (`eclipse-cdt.peripheral-inspector`) — optional, used by `read_peripheral_register` when available (falls back to SVD parsing + `readMemory`).
- **Arm CMSIS Solution** (`arm.cmsis-csolution`) — generates `launch.json` entries of type `gdbtarget` from a csolution project.

> **💡 Tip**: Enable auto-approval for all CMSIS-DebugMCP tools in your AI assistant to create seamless debugging workflows without constant approval interruptions.

## Quick Start — CMSIS Target

1. Open a CMSIS Solution project that produces a `.vscode/launch.json` with a `gdbtarget` configuration (e.g., `"CMSIS Debugger: pyOCD"` or `"CMSIS Debugger: J-LINK"`).
2. Ensure the AI assistant has CMSIS-DebugMCP registered as an MCP server (the extension offers auto-registration on first launch).
3. Ask your agent: *"Start debugging using configuration 'CMSIS Debugger: pyOCD'"* — the agent calls `start_debugging` with `configurationName` set, and CMSIS-DebugMCP passes the named config straight through to `vscode.debug.startDebugging()`.
4. After the target halts at `main`, ask the agent to read core registers, inspect memory, decode faults, or read peripheral registers.

## Quick Start — General Languages

1. Install the extension.
2. Open your project in VS Code.
3. Ask your AI to debug — it can set breakpoints, start debugging, and analyze your code using the auto-generated launch configuration for the file's language.

## Supported Languages & Targets

| Language / Target | Extension Required | File Extensions | Status |
|----------|-------------------|-----------------|---------|
| **Arm Cortex-M (gdbtarget)** | [Arm CMSIS Debugger](https://marketplace.visualstudio.com/items?itemName=Arm.vscode-cmsis-debugger) + [CDT GDB Debug Adapter](https://marketplace.visualstudio.com/items?itemName=eclipse-cdt.cdt-gdb-vscode) | `.axf`, `.elf` | ✅ Primary target |
| **Python** | [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python) | `.py` | ✅ Fully Supported |
| **JavaScript/TypeScript** | Built-in / [JS Debugger](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug) | `.js`, `.ts`, `.jsx`, `.tsx` | ✅ Fully Supported |
| **Java** | [Extension Pack for Java](https://marketplace.visualstudio.com/items?itemName=vscjava.vscode-java-pack) | `.java` | ✅ Fully Supported |
| **C/C++** | [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) | `.c`, `.cpp`, `.cc` | ✅ Fully Supported |
| **Go** | [Go](https://marketplace.visualstudio.com/items?itemName=golang.Go) | `.go` | ✅ Fully Supported |
| **Rust** | [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | `.rs` | ✅ Fully Supported |
| **PHP** | [PHP Debug](https://marketplace.visualstudio.com/items?itemName=xdebug.php-debug) | `.php` | ✅ Fully Supported |
| **Ruby** | [Ruby](https://marketplace.visualstudio.com/items?itemName=rebornix.ruby) | `.rb` | ✅ Fully Supported |
| **C#/.NET** | [C#](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) | `.cs` | ✅ Fully Supported |

## Configuration

### MCP Server Configuration (Recommended)

The extension runs an MCP server automatically. It will pop up a message to auto-register the MCP server in your AI assistant.

### Manual MCP Server Registration (Optional)

#### Cline
Add to your Cline settings or `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "cmsis-debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "CMSIS-DebugMCP - AI-driven Cortex-M debugging"
    }
  }
}
```

#### GitHub Copilot
Add to your VS Code settings (`settings.json`):
```json
{
  "mcp": {
    "servers": {
      "cmsis-debugmcp": {
        "type": "http",
        "url": "http://localhost:3001/mcp",
        "description": "CMSIS-DebugMCP - Cortex-M and multi-language debugging"
      }
    }
  }
}
```

#### Cursor
Add to Cursor's MCP settings:
```json
{
  "mcpServers": {
    "cmsis-debugmcp": {
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp",
      "description": "CMSIS-DebugMCP - Debugging tools for AI assistants"
    }
  }
}
```

#### Claude Code
Either use the agent selection popup, or register from a terminal:
```bash
claude mcp add --transport http --scope user cmsis-debugmcp http://localhost:3001/mcp
```
This writes a user-scoped entry to the top-level `mcpServers` of `~/.claude.json`:
```json
{
  "mcpServers": {
    "cmsis-debugmcp": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

#### Claude Desktop
Claude Desktop only supports stdio MCP servers, so the extension registers an `mcp-remote` bridge (requires Node.js/`npx` on PATH) in `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "cmsis-debugmcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3001/mcp"]
    }
  }
}
```
Config file location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json` (Linux).

### Extension Settings

Configure CMSIS-DebugMCP behavior in VSCode settings:

```json
{
  "cmsis-debugmcp.serverPort": 3001,
  "cmsis-debugmcp.timeoutInSeconds": 180
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `cmsis-debugmcp.serverPort` | `3001` | Preferred port for the MCP server. If busy, an OS-assigned port is used instead. |
| `cmsis-debugmcp.timeoutInSeconds` | `180` | Timeout for debugging operations |

Changing `serverPort` requires a window reload; the extension will offer to do it for you.

### Networking and multiple windows

The MCP server binds **`127.0.0.1` only** and rejects requests whose `Host`/`Origin` is not a loopback address. It has no authentication and can flash, erase, and read the memory of attached hardware, so it must never be exposed to a network. VS Code Remote SSH / WSL / Codespaces forward localhost, so those setups work unchanged.

Each VS Code window runs its own server. The first window to activate takes `serverPort`; later windows fall back to an OS-assigned port, so a window never shares another window's debug session. In-editor agents (Copilot) discover the right port automatically via the registered `McpServerDefinitionProvider`.

External CLI agents (Claude Code, Codex, Copilot CLI) read a single global config file, which can only name one URL — the most recently activated window wins. If you drive hardware from a CLI agent, keep one CMSIS-DebugMCP window open, or re-run **CMSIS-DebugMCP: Show Agent Selection Popup** from the window you want the agent to attach to.


## FAQ

<details>
<summary><b>Which AI assistants are supported?</b></summary>

CMSIS-DebugMCP works with any MCP-compatible AI assistant, including **GitHub Copilot**, **Claude Code**, **Claude Desktop**, **Cline**, **Cursor**, **Roo Code**, **Windsurf**, and others. If your assistant supports the Model Context Protocol, it can use CMSIS-DebugMCP.
</details>

<details>
<summary><b>Does it work with VS Code Remote SSH / Codespaces / WSL?</b></summary>

Yes. CMSIS-DebugMCP runs as a VS Code extension with `extensionKind: workspace`, so it activates in the remote environment where your code lives. The MCP server runs on `localhost` within that remote context.
</details>

<details>
<summary><b>Do I need to configure launch.json?</b></summary>

For CMSIS / `gdbtarget` sessions — yes. Generate one via the CMSIS Solution extension and pass its name as `configurationName` to `start_debugging`. CMSIS-DebugMCP passes named configurations straight through to `vscode.debug.startDebugging()` without modification.

For other languages — no. CMSIS-DebugMCP can auto-generate a debug configuration based on file extension. If you have a `launch.json`, it will use matching configurations from there.
</details>

<details>
<summary><b>Is my code sent to any external service?</b></summary>

No. CMSIS-DebugMCP runs 100% locally. The MCP server runs on `localhost`, and no code, variables, or debug data is sent to any external service. The AI assistant communicates with the MCP server entirely within your local machine.
</details>

<details>
<summary><b>What if port 3001 is already in use?</b></summary>

Change the port in VS Code settings: `"cmsis-debugmcp.serverPort": 3002` (or any available port). Then update your AI assistant's MCP configuration to use the new port.
</details>

<details>
<summary><b>Can I debug unit tests?</b></summary>

Yes. Pass the `testName` parameter to `start_debugging` to debug a specific test method. CMSIS-DebugMCP will configure the debug session to run and pause at breakpoints within that test.
</details>

<details>
<summary><b>Why is my AI assistant not using the debug tools?</b></summary>

Make sure CMSIS-DebugMCP is registered in your AI assistant's MCP settings. The extension should auto-detect and offer to register itself. If not, see the [Manual MCP Server Registration](#manual-mcp-server-registration-optional) section. Also enable auto-approval for CMSIS-DebugMCP tools for a smoother workflow.
</details>

## Troubleshooting

### Common Issues

#### MCP Server Not Starting
- **Symptom**: AI assistant can't connect to CMSIS-DebugMCP
- **Solution**: 
  - Check if port 3001 is available
  - Restart VSCode
  - Verify extension is installed and activated

#### CMSIS `gdbtarget` Session Fails to Launch
- **Symptom**: `start_debugging` returns an error when `configurationName` is a `gdbtarget` config
- **Solution**:
  - Verify the named configuration exists in `.vscode/launch.json`
  - Ensure the **Arm CMSIS Debugger** and **CDT GDB Debug Adapter** extensions are installed
  - Check that the `program` path (`.axf`/`.elf`) referenced by the configuration exists
  - Confirm the GDB server (pyOCD or J-Link) is available on your `PATH`

## How It Works

### Architecture

```
AI Agent ──MCP/HTTP──► CMSIS-DebugMCP (VS Code extension)
                         │
                         ├── vscode.debug.* ─► CDT GDB Debug Adapter (gdbtarget)
                         │                       │
                         │                   arm-none-eabi-gdb (GDB MI)
                         │                       │
                         │                   pyOCD / J-Link GDB Server
                         │                       │
                         │                   SWD/JTAG ─► Cortex-M target
                         │
                         └── Peripheral Inspector API / SVD parser → register decode
```

### Launch Configuration Integration
The extension handles debug configurations intelligently:

- **Named configuration passthrough**: When `start_debugging` is called with `configurationName`, CMSIS-DebugMCP resolves the entry from `.vscode/launch.json` and passes it directly to `vscode.debug.startDebugging()` — no language detection, no config rewriting. This is how `gdbtarget`/CMSIS configs are launched.
- **Existing launch.json**: If a `.vscode/launch.json` exists and no `configurationName` is given, a matching configuration is chosen based on the source file's language.
- **Default configuration**: If no launch.json exists and no `configurationName` is given, an appropriate default configuration is synthesized per language based on file-extension detection.


## Requirements

- VSCode with appropriate language extensions installed:
  - **Python**: [Python extension](vscode:extension/ms-python.debugpy) for `.py` files
  - **JavaScript/TypeScript**: Built-in Node.js debugger or [JavaScript Debugger extension](vscode:extension/ms-vscode.js-debug)
  - **Java**: [Extension Pack for Java](vscode:extension/vscjava.vscode-java-pack)
  - **C#/.NET**: [C# extension](vscode:extension/ms-dotnettools.csharp)
  - **C/C++**: [C/C++ extension](vscode:extension/ms-vscode.cpptools)
  - **Go**: [Go extension](vscode:extension/golang.go)
  - **Rust**: [rust-analyzer extension](vscode:extension/rust-lang.rust-analyzer)
  - **PHP**: [PHP Debug extension](vscode:extension/xdebug.php-debug)
  - **Ruby**: [Ruby extension](vscode:extension/rebornix.ruby) with debug support
- MCP-compatible AI assistant (Copilot, Cline, Roo..)

## Development

To build the extension:

```bash
npm install
npm run compile
```

## Contributing

This project is a fork of [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details. Upstream contributions that go back to DebugMCP remain governed by the upstream CLA.

## Security

See [SECURITY.md](SECURITY.md) for reporting guidance. Do not report security vulnerabilities through public GitHub issues.

## License

MIT License — see [LICENSE.txt](LICENSE.txt) for details.

Based on **DebugMCP**, originally created by **Oz Zafar**, **Ori Bar-Ilan** and **Karin Brisker** (Microsoft). CMSIS/Cortex-M embedded extensions maintained by Matthias Hertel (Arm).
