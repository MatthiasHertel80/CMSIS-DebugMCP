# CMSIS-DebugMCP — Changes vs. Upstream

This fork of [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) adapts the MCP debugger server for **Arm Cortex-M targets driven through the CMSIS Debugger VS Code extension**. Upstream DebugMCP is language-agnostic; it assumes a `vscode.debug.startDebugging(...)` call against a standard `launch.json` of type `python`, `node`, `cppdbg`, etc. It has no concept of a GDB target server, no memory or register reads, no fault decoding, and no SVD awareness. Everything in this document exists because that is the gap to close before an AI agent can debug real embedded hardware (pyOCD / J-Link / CMSIS-DAP + `gdbtarget`).

Upstream commit this fork is based on: [`4422d8c` — "upgrade version"](https://github.com/microsoft/DebugMCP/commit/4422d8c).

---

## 1. Why the changes are needed

| Upstream assumption | Reality for CMSIS / Cortex-M debugging | What the fork does |
|---|---|---|
| Debug session is started from a source file path (`fileFullPath`) | CMSIS Solution generates `launch.json` entries of `type: "gdbtarget"` that reference a `.cmsis/*.cbuild-run.yml` and a compiled `.elf` — the debugger is driven by a named configuration, not by opening a `.py`/`.ts` file | `start_debugging` accepts `configurationName` and routes it straight to `vscode.debug.startDebugging(workspaceFolder, name)`; `fileFullPath` becomes optional |
| No memory inspection | First question for any Cortex-M bug: "what's actually at `0x2000_0000`?" | New `read_memory` tool (DAP `readMemory` request with GDB expression fallback) |
| No core register inspection | R0–R15 / xPSR / MSP / PSP / CONTROL / FAULTMASK / BASEPRI / PRIMASK are mandatory for crash analysis, stack walking, and processor-mode reasoning | New `read_core_registers` tool (GDB MI via DAP `evaluate` with `context: 'repl'`) |
| No peripheral awareness | Embedded bugs are frequently peripheral-config bugs; the value of `GPIOA->ODR` or `RCC->CR` is load-bearing | New `read_peripheral_register` tool backed by SVD — primary path is the **Peripheral Inspector** extension API, with a standalone SVD parser fallback |
| No fault-state decoder | A HardFault tells you nothing without CFSR/HFSR/DFSR/MMFAR/BFAR decode | New `get_fault_info` tool that reads the SCS registers and decodes bit-by-bit (STKOF, UNALIGNED, PRECISERR, IACCVIOL, …) |
| No probe / target introspection | Agents need to know which device, which probe, which GDB server before they can reason about anything | New `get_device_info` tool summarizing session type, program, GDB path, GDB server, port, CMSIS config |
| Stepping via `workbench.action.debug.stepOver` UI commands | Flaky under `gdbtarget` — races with DAP state, and does not give a threadId back | `DebuggingExecutor` now prefers DAP `next` / `stepIn` / `stepOut` custom requests with the active threadId; falls back to the UI command only on failure |
| Embedded-specific guidance absent from agent docs | AI agents pick up bad habits (e.g. `info registers` passed to an expression evaluator, or stepping before the target is halted) | New agent resources: `cmsis-debugmcp://docs/cmsis-embedded-guide` and `cmsis-debugmcp://docs/troubleshooting/embedded` |
| Publisher / identifiers tied to the Microsoft / upstream author | Private distribution without collision | Full rename: extension id, config section, command namespace, output channel, MCP server name, resource URIs |

---

## 2. File-by-file change list

All paths are relative to the extension root (`DebugMCP/`). Line counts are from `git diff --stat upstream/main HEAD` with `package-lock.json` excluded.

### New files (features that did not exist upstream)

| File | Lines | Purpose |
|---|---:|---|
| [`src/core/faultDecoder.ts`](src/core/faultDecoder.ts) | 92 | Cortex-M fault register decoder. CFSR/HFSR/DFSR/MMFAR/BFAR/AFSR → human-readable analysis. Exports `FAULT_REGISTER_ADDRESSES` (SCS memory-mapped addresses at `0xE000ED28` …). |
| [`src/core/peripheralReader.ts`](src/core/peripheralReader.ts) | 308 | Peripheral register reader. Strategy 1: call the Peripheral Inspector extension's public API (`eclipse-cdt.peripheral-inspector`). Strategy 2: locate the SVD referenced by the active CMSIS `cbuild-run.yml`, parse it, and read via DAP `readMemory` / GDB `evaluate`. |
| [`src/core/svdParser.ts`](src/core/svdParser.ts) | 341 | Minimal SVD XML parser. Resolves `derivedFrom`, computes field ranges, exposes `listPeripheralNames()` / `findPeripheral()` / `findRegister()` / `decodeFields()`. |
| [`docs/agent-resources/cmsis-embedded-guide.md`](docs/agent-resources/cmsis-embedded-guide.md) | 60 | Agent-facing guide on Cortex-M fault-decode recipes, SCS memory map, common register layouts, RTOS tips. Exposed as MCP resource `cmsis-debugmcp://docs/cmsis-embedded-guide`. |
| [`docs/agent-resources/troubleshooting/embedded.md`](docs/agent-resources/troubleshooting/embedded.md) | 63 | Embedded troubleshooting checklist (probe not detected, target not halted, SVD missing, wrong core selected on multi-core parts). Exposed as MCP resource. |

### Modified files

| File | +/− | What changed and why |
|---|---:|---|
| [`src/debugMCPServer.ts`](src/debugMCPServer.ts) | +153 / −… | Registers five new MCP tools (`read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`, `get_device_info`). Makes `fileFullPath` optional on `start_debugging`. Updates MCP server identity to `cmsis-debugmcp` and resource URIs to `cmsis-debugmcp://…`. Adds `express` import for the Streamable HTTP transport host (was inline `http` upstream). |
| [`src/debuggingHandler.ts`](src/debuggingHandler.ts) | +269 / −… | Five new handler methods (`handleReadMemory`, `handleReadCoreRegisters`, `handleReadPeripheralRegister`, `handleGetFaultInfo`, `handleGetDeviceInfo`). `handleStartDebugging` branches on `configurationName` → calls `startDebuggingByName` instead of synthesizing a `DebugConfiguration` from a file path. |
| [`src/debuggingExecutor.ts`](src/debuggingExecutor.ts) | +310 / −… | New `startDebuggingByName()` that calls `vscode.debug.startDebugging(folder, configName)`. New DAP-backed methods: `readMemory`, `readMemoryWord`, `readCoreRegisters`, `readPeripheralRegister`, `getFaultInfo`, `getDeviceInfo`. Replaces UI-command-based stepping with DAP `next` / `stepIn` / `stepOut` + threadId, with UI fallback. |
| [`src/extension.ts`](src/extension.ts) | +30 / −… | Renamed config section `debugmcp` → `cmsis-debugmcp`. Renamed all three commands (`configureAgents`, `showAgentSelectionPopup`, `resetPopupState`). Default timeout changed 180 → 60 s. |
| [`src/utils/agentConfigurationManager.ts`](src/utils/agentConfigurationManager.ts) | +60 / −… | Renamed globalState key to `cmsis-debugmcp.popupShown`. The MCP server entry written into Cline / Copilot / Cursor settings is now keyed `cmsis-debugmcp` and points at the new identifier. |
| [`src/utils/debugConfigurationManager.ts`](src/utils/debugConfigurationManager.ts) | +28 / −… | Generated launch-config names prefixed `CMSIS-DebugMCP:` instead of `DebugMCP:`. |
| [`src/utils/logger.ts`](src/utils/logger.ts) | +2 / −… | Output channel renamed to `CMSIS-DebugMCP`. |
| [`package.json`](package.json) | +42 / −… | `name`, `displayName`, `publisher`, `author`, `homepage`, `bugs`, `repository`, command ids, config section, keywords (added `embedded`, `cortex-m`, `cmsis`, `arm`, `gdbtarget`). |
| [`README.md`](README.md) | +214 / −… | Rewritten around the Cortex-M workflow: new Features table, a "Quick Start — CMSIS Target" section, documents the five embedded tools and the new MCP resources. Preserves the upstream multi-language table at the bottom. |
| [`CHANGELOG.md`](CHANGELOG.md) | +14 / −… | Fork entry for 1.0.9 listing the embedded additions. |
| [`AGENTS.md`](AGENTS.md) | +33 / −… | Updated agent-facing description and tool summary. |
| [`docs/agent-resources/debug_instructions.md`](docs/agent-resources/debug_instructions.md) | +2 / −… | Title and tool list updated for CMSIS context. |
| [`docs/architecture/debugMCPServer.md`](docs/architecture/debugMCPServer.md) | +19 / −… | Tool table extended with the five embedded tools. |
| [`docs/architecture/agentConfigurationManager.md`](docs/architecture/agentConfigurationManager.md) | +16 / −… | Config-section and MCP-entry examples renamed. |
| [`docs/agent-resources/troubleshooting/csharp.md`](docs/agent-resources/troubleshooting/csharp.md) | +8 / −… | Stray upstream-name references updated. |

Diff summary (excluding `package-lock.json`):

```
15 files changed, 928 insertions(+), 272 deletions(-)
```

---

## 3. Renames (reference table)

| Kind | Upstream | Fork |
|---|---|---|
| npm `name` | `debugmcpextension` | `cmsis-debugmcp` |
| `displayName` | `DebugMCP` | `CMSIS-DebugMCP` |
| `publisher` | `ozzafar` | `mather01` |
| Config section | `debugmcp.*` | `cmsis-debugmcp.*` |
| Command ids | `debugmcp.showAgentSelectionPopup` etc. | `cmsis-debugmcp.showAgentSelectionPopup` etc. |
| Output channel | `DebugMCP` | `CMSIS-DebugMCP` |
| MCP server `name` | `debugmcp` | `cmsis-debugmcp` |
| MCP resource URIs | `debugmcp://docs/…` | `cmsis-debugmcp://docs/…` |
| globalState key | `debugmcp.popupShown` | `cmsis-debugmcp.popupShown` |
| Generated launch-config prefix | `DebugMCP:` | `CMSIS-DebugMCP:` |

---

## 4. New MCP surface (what an agent sees that wasn't upstream)

Tools:

- `read_memory(address, length, format)` — DAP `readMemory` with GDB fallback
- `read_core_registers()` — R0–R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK
- `read_peripheral_register(peripheral, register?)` — SVD-backed, names like `GPIOA`/`ODR`
- `get_fault_info()` — decoded CFSR/HFSR/DFSR/MMFAR/BFAR/AFSR
- `get_device_info()` — probe, device, GDB server, port, CMSIS config summary

Resources:

- `cmsis-debugmcp://docs/cmsis-embedded-guide`
- `cmsis-debugmcp://docs/troubleshooting/embedded`

Existing tools kept upstream-compatible except:

- `start_debugging` — `fileFullPath` is now optional; `configurationName` is the primary entry point for `gdbtarget` configs.

---

## 5. End-to-end validation

All 19 registered tools were exercised in a single session against an **Alif AppKit-E8** (dual Cortex-M55, CPUID `0x411FD220` = r1p2) attached via CMSIS-DAP through pyOCD, using the launch configuration `M55_HP CMSIS_DAP@pyOCD (launch)` from [`Test/ModelNova/.vscode/launch.json`](../Test/ModelNova/.vscode/launch.json). Reads of `0xE000ED00` returned the correct CPUID; 151 Alif peripherals enumerated via SVD; `get_fault_info` correctly reported `DFSR=0x2` (BKPT) with all other fault banks clear when halted at a breakpoint.

---

## 6. Known schema gaps for AI agents

Three tool schemas differ from names agents commonly guess — worth documenting for prompt-level hints:

- `read_memory` uses `length` (not `count`)
- `add_breakpoint` uses `fileFullPath` + `lineContent` (not `filePath` + `lineNumber`)
- `read_peripheral_register` uses `peripheral` + `register` (not `peripheralName` + `registerName`)

---

## 7. Relationship to upstream

This fork is **not** intended to be merged back as-is — the embedded tools would be dead code for the 95% of upstream users debugging Python/TypeScript. The clean path for upstreaming would be factoring `src/core/*` into an optional "embedded" feature module gated on the presence of the CMSIS Debugger extension, and making `read_memory` / `read_core_registers` available generically while keeping the SVD / fault decoder gated. That refactor is out of scope for this private evaluation build.
