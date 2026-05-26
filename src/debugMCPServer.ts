// Copyright (c) Microsoft Corporation.

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import express from 'express';
import {
    DebuggingExecutor,
    ConfigurationManager,
    DebuggingHandler,
    IDebuggingHandler
} from '.';
import { HardwareTimeouts } from './debuggingExecutor';
import { logger } from './utils/logger';
import { serialHandler } from './serialHandler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * Uses the official @modelcontextprotocol/sdk with SSE transport over express.
 */
export class DebugMCPServer {
    // No longer a singleton — a fresh McpServer is created per HTTP request
    // so concurrent tool calls don't trample each other's transport.
    private httpServer: http.Server | null = null;
    private port: number;
    private actualPort: number | null = null;
    private initialized: boolean = false;
    private debuggingHandler: IDebuggingHandler;
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();

    constructor(port: number, timeoutInSeconds: number, hardwareTimeouts?: Partial<HardwareTimeouts>) {
        // Initialize the debugging components with dependency injection
        const executor = new DebuggingExecutor(hardwareTimeouts);
        const configManager = new ConfigurationManager();
        this.debuggingHandler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
        this.port = port;
    }

    /**
     * Initialize the MCP server. With per-request McpServer instances, this
     * just flips the initialized flag — no shared server is constructed.
     */
    async initialize() {
        this.initialized = true;
    }

    /**
     * Build a fresh McpServer for a single HTTP request and register every
     * tool + resource on it. Per-request instances mean concurrent tool
     * calls cannot trample each other's transport (the bug that caused
     * `get_threads` to hang after the third call).
     */
    private createMcpServer(): McpServer {
        const mcpServer = new McpServer({
            name: 'cmsis-debugmcp',
            version: '1.1.9',
        });
        this.setupTools(mcpServer);
        this.setupResources(mcpServer);
        return mcpServer;
    }

    /**
     * Setup MCP tools that delegate to the debugging handler
     */
    private setupTools(mcpServer: McpServer) {
        const TIMEOUT_DESC = 'Optional per-call timeout in milliseconds (capped to 60 000). Overrides the default for this single tool call. Use it when you can estimate the work and want a tighter or looser bound.';

        // Get debug instructions tool (for clients that don't support MCP resources like GitHub Copilot)
        mcpServer.registerTool('get_debug_instructions', {
            description: 'Get the debugging guide with step-by-step instructions for effective debugging. ' +
                'Returns comprehensive guidance including breakpoint strategies, root cause analysis framework, ' +
                'and best practices. Call this before starting a debug session.',
        }, async () => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return { content: [{ type: 'text' as const, text: content }] };
        });

        // Start debugging tool
        mcpServer.registerTool('start_debugging', {
            description: 'Start a debug session via the standard VS Code debug pipeline (uses launch.json + the debug tab).' +
                '\n\n⚠️ FOR CMSIS / CORTEX-M PROJECTS: prefer `cmsis_action` with `action="load_and_debug"` ' +
                '(same as clicking *Debug* in the CMSIS Solution panel — builds if needed, flashes, then attaches). ' +
                '`start_debugging` skips the flash step and is the wrong tool for embedded targets that need ' +
                'fresh firmware on the chip.' +
                '\n\nUSE start_debugging FOR:' +
                '\n• Non-CMSIS projects (Python, Java, JavaScript/TypeScript, C#, Go, Rust, …)' +
                '\n• Attaching to an already-flashed CMSIS target where you specifically do NOT want to ' +
                'reprogram (use `cmsis_action attach` instead if you want the CMSIS panel\'s attach behavior)' +
                '\n\nUSE THIS WHEN debugging a code-side bug (wrong values, null/undefined, unexpected behavior, ' +
                'failing tests).' +
                '\n\n⚠️ CRITICAL: Before using this tool, first call get_debug_instructions or read ' +
                'cmsis-debugmcp://docs/debug_instructions resource!',
            inputSchema: {
                fileFullPath: z.string().optional().describe('Full path to the source code file to debug. Optional when configurationName is provided (e.g. for embedded/CMSIS gdbtarget configs).'),
                workingDirectory: z.string().describe('Working directory for the debug session'),
                testName: z.string().optional().describe(
                    'Name of a specific test name to debug. ' +
                    'Only provide this when debugging a single test method. ' +
                    'Leave empty to debug the entire file or test class.'
                ),
                configurationName: z.string().optional().describe(
                    'Name of a specific debug configuration from launch.json to use. ' +
                    'For embedded/CMSIS debugging, provide the configuration name (e.g. "CMSIS Debugger: pyOCD"). ' +
                    'Leave empty to be prompted to select a configuration interactively.'
                ),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleStartDebugging(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Stop debugging tool
        mcpServer.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => {
            const result = await this.debuggingHandler.handleStopDebugging();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step over tool
        mcpServer.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleStepOver(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step into tool
        mcpServer.registerTool('step_into', {
            description: 'Dive into the current line of code.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleStepInto(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step out tool
        mcpServer.registerTool('step_out', {
            description: 'Step out of the current function',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleStepOut(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Pause tool — halts a running target without ending the session.
        mcpServer.registerTool('pause_execution', {
            description: 'Pause a running target so inspection tools (variables, memory, registers, ' +
                'call stack) become valid. No-op if the target is already stopped. Returns the new ' +
                'debug state on success, or a structured error if the probe is unresponsive.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handlePause(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Continue execution tool
        mcpServer.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleContinue(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Restart debugging tool
        mcpServer.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleRestart(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add breakpoint tool
        mcpServer.registerTool('add_breakpoint', {
            description: 'Set a breakpoint to pause execution at a critical line of code. Essential for debugging: pause before potential errors, examine state at decision points, or verify code paths. Breakpoints let you inspect variables and control flow at exact moments.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                lineContent: z.string().describe('Line content'),
            },
        }, async (args: { fileFullPath: string; lineContent: string }) => {
            const result = await this.debuggingHandler.handleAddBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Remove breakpoint tool
        mcpServer.registerTool('remove_breakpoint', {
            description: 'Remove a breakpoint that is no longer needed.',
            inputSchema: {
                fileFullPath: z.string().describe('Full path to the file'),
                line: z.number().describe('Line number (1-based)'),
            },
        }, async (args: { fileFullPath: string; line: number }) => {
            const result = await this.debuggingHandler.handleRemoveBreakpoint(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Clear all breakpoints tool
        mcpServer.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => {
            const result = await this.debuggingHandler.handleClearAllBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List breakpoints tool
        mcpServer.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => {
            const result = await this.debuggingHandler.handleListBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get variables tool
        mcpServer.registerTool('get_variables_values', {
            description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleGetVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Evaluate expression tool
        mcpServer.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { expression: string; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleEvaluateExpression(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // ========== Embedded / Cortex-M Tools ==========

        // Read memory tool
        mcpServer.registerTool('read_memory', {
            description: 'Read a range of bytes from the target\'s memory. ' +
                'Use this for inspecting SRAM, Flash, peripheral registers, or the stack. ' +
                'Returns hex dump and/or ASCII representation.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                address: z.string().describe("Memory address as hex string, e.g. '0x20000000'"),
                length: z.number().int().min(1).max(4096).describe('Number of bytes to read (1-4096)'),
                format: z.enum(['hex', 'ascii', 'both']).default('both').describe('Output format'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleReadMemory(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read core registers tool
        mcpServer.registerTool('read_core_registers', {
            description: 'Read Cortex-M core registers: R0-R12, SP, LR, PC, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK. ' +
                'Essential for analyzing crash state, stack pointers, and processor mode.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleReadCoreRegisters(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read peripheral register tool
        mcpServer.registerTool('read_peripheral_register', {
            description: 'Read named peripheral registers using SVD data from the Peripheral Inspector extension. ' +
                'Provide a peripheral name (e.g. "GPIOA", "UART0", "SPI1") and optionally a register name. ' +
                'If the Peripheral Inspector is not available, provides guidance on using read_memory instead.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                peripheral: z.string().describe("Peripheral name, e.g. 'GPIOA', 'UART0', 'RCC'"),
                register: z.string().optional().describe("Register name, e.g. 'ODR', 'CR1'. If omitted, lists all registers in the peripheral."),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { peripheral: string; register?: string; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleReadPeripheralRegister(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get fault info tool
        mcpServer.registerTool('get_fault_info', {
            description: 'Read and decode Cortex-M fault status registers (CFSR, HFSR, BFAR, MMFAR, DFSR, AFSR). ' +
                'Call this when the target hits a HardFault, BusFault, MemManage, or UsageFault. ' +
                'Returns a human-readable analysis of which fault bits are set and what they mean.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleGetFaultInfo(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get device info tool
        mcpServer.registerTool('get_device_info', {
            description: 'Return information about the connected debug target: session name, debug type, program path, ' +
                'GDB path, GDB server, port, and CMSIS config details.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleGetDeviceInfo();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Check target connection tool
        mcpServer.registerTool('check_target_connection', {
            description: 'Probe the hardware debug connection with a short-timeout DAP ping. ' +
                'Use this when other tool calls start timing out or returning "unavailable" ' +
                'to determine whether the probe/GDB server is alive and whether the target ' +
                'is stopped (so DAP reads are valid). Never hangs — uses an internal short timeout.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleCheckTargetConnection();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get call stack tool
        mcpServer.registerTool('get_call_stack', {
            description: 'Return the full call stack (function names, source, line, frameId) for the active thread, ' +
                'or a specific thread when threadId is provided. Use the returned frameId values with ' +
                'get_frame_variables to inspect variables of caller frames without changing the active frame.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                threadId: z.number().int().optional().describe('Optional DAP thread id (from get_threads). Defaults to the active thread.'),
                levels: z.number().int().min(1).max(200).optional().describe('Maximum frames to return (default 50).'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { threadId?: number; levels?: number; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleGetCallStack(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get threads / RTOS tasks tool
        mcpServer.registerTool('get_threads', {
            description: 'List DAP threads reported by the debug adapter. With an RTOS-aware GDB server ' +
                '(pyOCD --rtos, J-Link RTOS plugin) each FreeRTOS / RTX / ThreadX task appears as a thread, ' +
                'matching the xRTOS viewer task list. Returns the thread id, name and top frame; pair with ' +
                'get_call_stack(threadId=...) to inspect any task\'s call stack.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: { timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC) },
        }, async (args: { timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleGetThreads(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get frame variables tool
        mcpServer.registerTool('get_frame_variables', {
            description: 'Inspect variables of a specific stack frame by its frameId (obtained from get_call_stack). ' +
                'Lets you walk up the call stack and examine caller-frame state without changing the ' +
                'editor\'s active frame.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                frameId: z.number().int().describe('DAP frame id, as returned by get_call_stack.'),
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC),
            },
        }, async (args: { frameId: number; scope?: 'local' | 'global' | 'all'; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleGetFrameVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // ========== Serial — dual backend ==========
        //
        // Two backends, one tool surface:
        //   • OWNED: serialController opens a port via `serialport` (we own it).
        //   • BRIDGE: serialMonitorBridge taps the MS Serial Monitor extension
        //     API at runtime — uses whatever the public API exposes today
        //     (port enum), and auto-lights up data subscription if MS adds it.
        //
        // OS reality: only one process can read a tty in non-exclusive mode.
        // If the user has an MS Serial Monitor session open on the same path,
        // the OWNED backend will fail to open. Use serial_subscribe_monitor
        // in that case (zero conflict — taps via API, not the kernel).

        mcpServer.registerTool('serial_list_ports', {
            description: 'List available serial ports. Tries the MS Serial Monitor API first (friendly names), ' +
                'falls back to the bundled serialport library.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await serialHandler.handleListPorts();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_open', {
            description: 'Open an OWNED serial port. The MCP server holds the connection and buffers RX. ' +
                'Use only when no MS Serial Monitor UI session is active on the same path — the OS allows ' +
                'one reader per tty. Defaults: 115200 baud, 8N1, no flow control.',
            inputSchema: {
                path: z.string().describe("Device path, e.g. '/dev/tty.usbmodemABCD' on macOS or 'COM3' on Windows"),
                baudRate: z.number().int().optional().describe('Baud rate (default 115200)'),
                dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
                parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
                stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
                rtscts: z.boolean().optional().describe('RTS/CTS hardware flow control (default false)'),
            },
        }, async (args: { path: string; baudRate?: number; dataBits?: 5 | 6 | 7 | 8; parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'; stopBits?: 1 | 1.5 | 2; rtscts?: boolean }) => {
            const result = await serialHandler.handleOpen(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_close', {
            description: 'Close the OWNED serial port (does not affect the MS Serial Monitor UI).',
        }, async () => {
            const result = await serialHandler.handleClose();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_status', {
            description: 'Report state of both backends: owned port (open / buffer size) and Serial Monitor ' +
                'bridge (extension installed / activated / data-subscription available / subscribed). ' +
                'Includes the discovered API keys so you can see what MS exposes in the installed build.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await serialHandler.handleStatus();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_write', {
            description: 'Write to the OWNED serial port. Encoding utf8 (default) or hex.',
            inputSchema: {
                data: z.string().describe("Payload. For encoding='hex' use a hex string like '0a 1b 2c'."),
                encoding: z.enum(['utf8', 'hex']).optional(),
                appendNewline: z.boolean().optional().describe("Append '\\n' to utf8 payloads (default false)"),
            },
        }, async (args: { data: string; encoding?: 'utf8' | 'hex'; appendNewline?: boolean }) => {
            const result = await serialHandler.handleWrite(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_read', {
            description: 'Read buffered RX bytes from either backend. ' +
                "Set from='owned' (default) for the MCP-owned port, from='monitor' for bytes captured " +
                'via the Serial Monitor bridge subscription. consume=true (default) drains the buffer; ' +
                'consume=false peeks. waitMs blocks up to that many ms when buffer is empty.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                maxBytes: z.number().int().min(1).optional(),
                waitMs: z.number().int().min(0).max(60000).optional(),
                consume: z.boolean().optional(),
                format: z.enum(['utf8', 'hex', 'both']).optional(),
                from: z.enum(['owned', 'monitor']).optional().describe("Backend to read from (default 'owned')"),
            },
        }, async (args: { maxBytes?: number; waitMs?: number; consume?: boolean; format?: 'utf8' | 'hex' | 'both'; from?: 'owned' | 'monitor' }) => {
            const result = await serialHandler.handleRead(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_clear_buffer', {
            description: "Discard buffered RX without reading. from='owned' (default) or 'monitor'.",
            inputSchema: {
                from: z.enum(['owned', 'monitor']).optional(),
            },
        }, async (args: { from?: 'owned' | 'monitor' }) => {
            const result = await serialHandler.handleClearBuffer(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_subscribe_monitor', {
            description: 'Subscribe to the MS Serial Monitor extension\'s public data event so the agent can ' +
                'read bytes the *user\'s* UI session receives — no port fight, no closing the panel. ' +
                'Probes ext.exports for any of: onDidReceiveData / onDataReceived / onData / onSerialData / ' +
                'onDidReadData / subscribeData. If the installed Serial Monitor build does not expose a data ' +
                'event yet, returns a clear error and you should fall back to serial_open (owned port). ' +
                "After subscribing, read with serial_read from='monitor'.",
        }, async () => {
            const result = await serialHandler.handleSubscribeMonitor();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_unsubscribe_monitor', {
            description: 'Stop the Serial Monitor data subscription (the user\'s UI session is unaffected).',
        }, async () => {
            const result = await serialHandler.handleUnsubscribeMonitor();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        mcpServer.registerTool('serial_open_monitor', {
            description: 'Focus the Microsoft Serial Monitor panel so the user can see / drive their existing ' +
                'session. UI-only — does not open or read a port. Pair with serial_subscribe_monitor to also ' +
                'feed bytes back to the agent.',
        }, async () => {
            const result = await serialHandler.handleOpenInUi();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // CMSIS Solution flash / debug control tool — wraps the CMSIS panel buttons.
        mcpServer.registerTool('cmsis_action', {
            description: '⭐ PREFERRED entry point for CMSIS / Cortex-M debugging. Drives the CMSIS Solution ' +
                'extension — same as clicking the buttons in the CMSIS Solution panel. Operates on the ' +
                'currently active csolution context (the one selected in the panel).\n\n' +
                'For embedded debug, ALWAYS choose cmsis_action over start_debugging — start_debugging uses the ' +
                'plain VS Code debug tab and skips the build / flash pipeline that CMSIS Solution orchestrates.\n\n' +
                'Actions:\n' +
                '  • build           — build the active context\n' +
                '  • load            — flash download to the target\n' +
                '  • erase           — erase target flash\n' +
                '  • load_and_run    — flash and run (no debug session)\n' +
                '  • load_and_debug  — flash and start a debug session (the "Debug" button). Waits for the session to be ready.\n' +
                '  • attach          — attach debugger to an already-flashed target (skips programming). Waits for the session to be ready.\n' +
                '  • detach          — detach debugger\n' +
                '  • stop_run        — stop a previous load_and_run',
            inputSchema: {
                action: z.enum([
                    'build', 'load', 'erase',
                    'load_and_run', 'load_and_debug',
                    'attach', 'detach', 'stop_run',
                ]).describe('Which CMSIS Solution action to invoke'),
                timeoutMs: z.number().int().min(100).max(60_000).optional().describe(TIMEOUT_DESC + ' Applies to the session-readiness wait for load_and_debug / attach.'),
            },
        }, async (args: { action: 'build' | 'load' | 'erase' | 'load_and_run' | 'load_and_debug' | 'attach' | 'detach' | 'stop_run'; timeoutMs?: number }) => {
            const result = await this.debuggingHandler.handleCmsisCommand(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get session status tool
        mcpServer.registerTool('get_session_status', {
            description: 'Report the current debug-session state in one of five categories: ' +
                '`no-session`, `initializing`, `running`, `stopped`, or `unresponsive`. ' +
                'Use this whenever you are unsure whether a session is alive — e.g. after a tool ' +
                'returned "Debug session is not ready", after a long continue_execution, or after ' +
                'an apparent timeout. This tool never hangs and never throws: it always returns a ' +
                'classification plus a hint about what to do next. Prefer this over guessing from ' +
                'failed tool calls.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleGetSessionStatus();
            return { content: [{ type: 'text' as const, text: result }] };
        });
    }

    /**
     * Setup MCP resources for documentation
     */
    private setupResources(mcpServer: McpServer) {
        // Add MCP resources for debugging documentation
        mcpServer.registerResource('Debugging Instructions Guide', 'cmsis-debugmcp://docs/debug_instructions', {
            description: 'Step-by-step instructions for debugging with CMSIS-DebugMCP',
            mimeType: 'text/markdown',
        }, async (uri: URL) => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text: content,
                }]
            };
        });

        // Add language-specific resources
        const languages = ['python', 'javascript', 'java', 'csharp'];
        const languageTitles: Record<string, string> = {
            'python': 'Python Debugging Tips',
            'javascript': 'JavaScript Debugging Tips',
            'java': 'Java Debugging Tips',
            'csharp': 'C# Debugging Tips'
        };

        languages.forEach(language => {
            mcpServer.registerResource(
                languageTitles[language],
                `cmsis-debugmcp://docs/troubleshooting/${language}`,
                {
                    description: `Debugging tips specific to ${language}`,
                    mimeType: 'text/markdown',
                },
                async (uri: URL) => {
                    const content = await this.loadMarkdownFile(`agent-resources/troubleshooting/${language}.md`);
                    return {
                        contents: [{
                            uri: uri.href,
                            mimeType: 'text/markdown',
                            text: content,
                        }]
                    };
                }
            );
        });

        // Add CMSIS embedded debugging guide resource
        mcpServer.registerResource(
            'CMSIS Embedded Debugging Guide',
            'cmsis-debugmcp://docs/cmsis-embedded-guide',
            {
                description: 'Comprehensive guide for debugging Cortex-M embedded targets using CMSIS tools, including fault analysis, peripheral inspection, and memory layout.',
                mimeType: 'text/markdown',
            },
            async (uri: URL) => {
                const content = await this.loadMarkdownFile('agent-resources/cmsis-embedded-guide.md');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: content,
                    }]
                };
            }
        );

        // Add embedded troubleshooting resource
        mcpServer.registerResource(
            'Embedded Debugging Tips',
            'cmsis-debugmcp://docs/troubleshooting/embedded',
            {
                description: 'Troubleshooting tips for embedded Cortex-M debugging, HardFault analysis, and peripheral issues.',
                mimeType: 'text/markdown',
            },
            async (uri: URL) => {
                const content = await this.loadMarkdownFile('agent-resources/troubleshooting/embedded.md');
                return {
                    contents: [{
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: content,
                    }]
                };
            }
        );
    }

    /**
     * Load content from a Markdown file in the docs directory
     */
    private async loadMarkdownFile(relativePath: string): Promise<string> {
        try {
            // Get the extension's installation directory
            const extensionPath = __dirname; // This points to the compiled extension's directory
            const docsPath = path.join(extensionPath, '..', 'docs', relativePath);

            console.log(`Loading markdown file from: ${docsPath}`);

            // Read the file content
            const content = await fs.promises.readFile(docsPath, 'utf8');
            console.log(`Successfully loaded ${relativePath}, content length: ${content.length}`);

            return content;
        } catch (error) {
            console.error(`Failed to load ${relativePath}:`, error);
            return `Error loading documentation from ${relativePath}: ${error}`;
        }
    }

    /**
     * Check if the server is already running
     */
    private async isServerRunning(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const request = http.request({
                hostname: 'localhost',
                port: this.port,
                path: '/',
                method: 'GET',
                timeout: 1000
            }, () => {
                resolve(true); // Server is responding
            });

            request.on('error', () => {
                resolve(false); // Server is not running
            });

            request.on('timeout', () => {
                request.destroy();
                resolve(false); // Server is not responding
            });

            request.end();
        });
    }

    /**
     * Start the MCP server with Streamable HTTP transport
     */
    async start(): Promise<void> {
        try {
            logger.info(`Starting CMSIS-DebugMCP server (preferred port ${this.port})...`);

            const app = express();

            // Parse JSON body for incoming requests
            app.use(express.json());

            // Streamable HTTP endpoint — handles MCP protocol messages.
            // Each POST creates its own McpServer + transport pair so
            // concurrent tool calls cannot trample each other's transport.
            app.post('/mcp', async (req: any, res: any) => {
                logger.info('New MCP request received');

                const perRequestServer = this.createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined, // Stateless mode
                });

                res.on('close', () => {
                    transport.close().catch(() => { /* ignore */ });
                    perRequestServer.close().catch(() => { /* ignore */ });
                    logger.info('MCP transport closed');
                });

                try {
                    await perRequestServer.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                } catch (err) {
                    logger.error('MCP request handling failed', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: String(err) });
                    }
                }
            });

            // Legacy SSE endpoint for backward compatibility
            app.get('/sse', async (req: any, res: any) => {
                res.status(410).json({ 
                    error: 'SSE endpoint deprecated', 
                    message: 'Please use POST /mcp endpoint instead',
                    newEndpoint: '/mcp'
                });
            });

            // Try the configured port first; fall back to an OS-assigned port
            // so multiple IDE windows each get their own server.
            this.httpServer = await this.listenWithFallback(app, this.port);
            const addr = this.httpServer.address();
            this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
            logger.info(`CMSIS-DebugMCP server started successfully on port ${this.actualPort}`);

        } catch (error) {
            logger.error(`Failed to start CMSIS-DebugMCP server`, error);
            throw new Error(`Failed to start CMSIS-DebugMCP server: ${error}`);
        }
    }

    /**
     * Try to listen on preferredPort. If it is already in use, let the OS
     * assign a free port (port 0) so multiple IDE instances never collide.
     */
    private listenWithFallback(app: ReturnType<typeof express>, preferredPort: number): Promise<http.Server> {
        return new Promise<http.Server>((resolve, reject) => {
            const server = app.listen(preferredPort, () => resolve(server));
            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    logger.warn(`Port ${preferredPort} already in use – requesting OS-assigned port`);
                    const fallback = app.listen(0, () => resolve(fallback));
                    fallback.on('error', reject);
                } else {
                    reject(err);
                }
            });
        });
    }

    /**
     * Stop the MCP server
     */
    async stop() {
        // Note: With stateless StreamableHTTPServerTransport, transports are closed per-request
        // No need to track and close them manually
        this.transports.clear();

        // Release any owned serial port and unsubscribe from the Serial Monitor bridge.
        try {
            const { serialController } = await import('./core/serialController.js');
            await serialController.close();
            const { serialMonitorBridge } = await import('./core/serialMonitorBridge.js');
            serialMonitorBridge.unsubscribe();
        } catch (err) {
            logger.warn(`Failed to clean up serial backends on shutdown: ${err}`);
        }


        // Close the HTTP server
        if (this.httpServer) {
            await new Promise<void>((resolve) => {
                this.httpServer!.close(() => resolve());
            });
            this.httpServer = null;
        }

        logger.info('CMSIS-DebugMCP server stopped');
    }

    /**
     * Get the port the server is actually listening on.
     * May differ from the configured port when the preferred port was busy.
     */
    getActualPort(): number {
        return this.actualPort ?? this.port;
    }

    /**
     * Get the server endpoint
     */
    getEndpoint(): string {
        return `http://localhost:${this.getActualPort()}`;
    }

    /**
     * Get the debugging handler (for testing purposes)
     */
    getDebuggingHandler(): IDebuggingHandler {
        return this.debuggingHandler;
    }

    /**
     * Check if the server is initialized
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}