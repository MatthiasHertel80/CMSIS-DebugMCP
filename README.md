# CMSIS-DebugMCP — AI-Driven Debugging for Arm Cortex-M Targets

CMSIS-DebugMCP is an MCP server that lets an AI agent drive the VS Code debugger against Arm Cortex-M targets through the **CMSIS Debugger** extension — setting breakpoints, stepping, reading memory and core registers, decoding fault status, and inspecting peripheral registers via SVD. It also retains general multi-language debugging support (Python, JavaScript/TypeScript, Java, C#, C++, Go, Rust, PHP, Ruby) inherited from the upstream DebugMCP project.

Works with **GitHub Copilot**, **Cline**, **Cursor**, and any MCP-compatible assistant.

> This project is a fork of [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) extended for Arm embedded workflows. See [CHANGELOG.md](CHANGELOG.md) for the list of embedded-specific additions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104.0+-blue.svg)](https://code.visualstudio.com/)
[![Version](https://img.shields.io/badge/version-1.0.9-green.svg)](https://github.com/mather01/DebugMCP)

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

### 🔧 Core Debug Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **get_debug_instructions** | Get the debugging guide with best practices and workflow instructions | None |
| **start_debugging** | Start a debug session — pass `configurationName` to launch a `gdbtarget`/CMSIS config from `launch.json` | `configurationName` (optional)<br>`fileFullPath` (optional when `configurationName` is provided)<br>`workingDirectory` (optional)<br>`testName` (optional) |
| **stop_debugging** | Stop the current debug session | None |
| **step_over** | Execute the next line (step over function calls) | None |
| **step_into** | Step into function calls | None |
| **step_out** | Step out of the current function | None |
| **continue_execution** | Continue until next breakpoint | None |
| **restart_debugging** | Restart the current debug session | None |
| **add_breakpoint** | Add a breakpoint at a specific line | `fileFullPath` (required)<br>`lineContent` (required) |
| **remove_breakpoint** | Remove a breakpoint from a specific line | `fileFullPath` (required)<br>`line` (required) |
| **clear_all_breakpoints** | Remove all breakpoints at once | None |
| **list_breakpoints** | List all active breakpoints | None |
| **get_variables_values** | Get variables and their values at current execution point | `scope` (optional: 'local', 'global', 'all') |
| **evaluate_expression** | Evaluate an expression in debug context | `expression` (required) |

### 🧠 Embedded / Cortex-M Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| **read_memory** | Read a range of bytes from the target | `address` (hex string, e.g. `0x20000000`)<br>`length` (1-4096 bytes)<br>`format` (`hex` / `ascii` / `both`) |
| **read_core_registers** | Read Cortex-M core registers (R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK) | None |
| **read_peripheral_register** | Read peripheral registers using SVD definitions (via Peripheral Inspector or SVD fallback) | `peripheral` (e.g. `GPIOA`)<br>`register` (optional; omit to list all registers of the peripheral) |
| **get_fault_info** | Read and decode CFSR / HFSR / DFSR / MMFAR / BFAR / AFSR for HardFault analysis | None |
| **get_device_info** | Return session info: device, probe, processor, GDB server, ports | None |

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

### 🛡️ Security & Reliability
- **Secure Communication**: All MCP communications use secure protocols
- **Local Operation**: The MCP server runs 100% locally with no external communications and requires no credentials
- **State Validation**: Robust validation of debugging states and operations

## Installation

### From source (VSIX)

```bash
git clone https://github.com/mather01/DebugMCP.git
cd DebugMCP
npm install
npm run compile
npx vsce package
code --install-extension cmsis-debugmcp-1.0.9.vsix
```

The extension activates on startup and registers an MCP server on `http://localhost:3001/mcp` by default.

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
| `cmsis-debugmcp.serverPort` | `3001` | Port number for the MCP server |
| `cmsis-debugmcp.timeoutInSeconds` | `180` | Timeout for debugging operations |


## FAQ

<details>
<summary><b>Which AI assistants are supported?</b></summary>

CMSIS-DebugMCP works with any MCP-compatible AI assistant, including **GitHub Copilot**, **Cline**, **Cursor**, **Roo Code**, **Windsurf**, and others. If your assistant supports the Model Context Protocol, it can use CMSIS-DebugMCP.
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
