// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
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
import { logger } from './utils/logger';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Main MCP server class that exposes debugging functionality as tools and resources.
 * Uses the official @modelcontextprotocol/sdk with SSE transport over express.
 */
export class DebugMCPServer {
    private mcpServer: McpServer | null = null;
    private httpServer: http.Server | null = null;
    private port: number;
    private initialized: boolean = false;
    private debuggingHandler: IDebuggingHandler;
    private transports: Map<string, StreamableHTTPServerTransport> = new Map();

    constructor(port: number, timeoutInSeconds: number) {
        // Initialize the debugging components with dependency injection
        const executor = new DebuggingExecutor();
        const configManager = new ConfigurationManager();
        this.debuggingHandler = new DebuggingHandler(executor, configManager, timeoutInSeconds);
        this.port = port;
    }

    /**
     * Initialize the MCP server
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        this.mcpServer = new McpServer({
            name: 'cmsis-debugmcp',
            version: '1.0.9',
        });

        this.setupTools();
        this.setupResources();
        this.initialized = true;
    }

    /**
     * Setup MCP tools that delegate to the debugging handler
     */
    private setupTools() {
        // Get debug instructions tool (for clients that don't support MCP resources like GitHub Copilot)
        this.mcpServer!.registerTool('get_debug_instructions', {
            description: 'Get the debugging guide with step-by-step instructions for effective debugging. ' +
                'Returns comprehensive guidance including breakpoint strategies, root cause analysis framework, ' +
                'and best practices. Call this before starting a debug session.',
        }, async () => {
            const content = await this.loadMarkdownFile('agent-resources/debug_instructions.md');
            return { content: [{ type: 'text' as const, text: content }] };
        });

        // Start debugging tool
        this.mcpServer!.registerTool('start_debugging', {
            description: 'IMPORTANT DEBUGGING TOOL - Start a debug session for a code file' +
                '\n\nUSE THIS WHEN:' +
                '\n• Any bug, error, or unexpected behavior occurs' +
                '\n• Asked to debug a unit test' +
                '\n• Variables have wrong/null values' +
                '\n• Functions return incorrect results' +
                '\n• Code behaves differently than expected' +
                '\n• User reports "it doesn\'t work"' +
                '\n\n⚠️ CRITICAL: Before using this tool, first call get_debug_instructions or read cmsis-debugmcp://docs/debug_instructions resource!',
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
            },
        }, async (args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string }) => {
            const result = await this.debuggingHandler.handleStartDebugging(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Stop debugging tool
        this.mcpServer!.registerTool('stop_debugging', {
            description: 'Stop the current debug session',
        }, async () => {
            const result = await this.debuggingHandler.handleStopDebugging();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step over tool
        this.mcpServer!.registerTool('step_over', {
            description: 'Execute the current line of code without diving into it.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOver();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step into tool
        this.mcpServer!.registerTool('step_into', {
            description: 'Dive into the current line of code.',
        }, async () => {
            const result = await this.debuggingHandler.handleStepInto();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Step out tool
        this.mcpServer!.registerTool('step_out', {
            description: 'Step out of the current function',
        }, async () => {
            const result = await this.debuggingHandler.handleStepOut();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Continue execution tool
        this.mcpServer!.registerTool('continue_execution', {
            description: 'Resume program execution until the next breakpoint is hit or the program completes.',
        }, async () => {
            const result = await this.debuggingHandler.handleContinue();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Restart debugging tool
        this.mcpServer!.registerTool('restart_debugging', {
            description: 'Restart the debug session from the beginning with the same configuration.',
        }, async () => {
            const result = await this.debuggingHandler.handleRestart();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Add breakpoint tool
        this.mcpServer!.registerTool('add_breakpoint', {
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
        this.mcpServer!.registerTool('remove_breakpoint', {
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
        this.mcpServer!.registerTool('clear_all_breakpoints', {
            description: 'Clear all breakpoints at once. Use this after verifying the root cause to clean up before moving on to the next task.',
        }, async () => {
            const result = await this.debuggingHandler.handleClearAllBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // List breakpoints tool
        this.mcpServer!.registerTool('list_breakpoints', {
            description: 'View all currently set breakpoints across all files.',
        }, async () => {
            const result = await this.debuggingHandler.handleListBreakpoints();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get variables tool
        this.mcpServer!.registerTool('get_variables_values', {
            description: 'Inspect all variable values at the current execution point. This is your window into program state - see what data looks like at runtime, verify assumptions, identify unexpected values, and understand why code behaves as it does.',
            inputSchema: {
                scope: z.enum(['local', 'global', 'all']).optional().describe("Variable scope: 'local', 'global', or 'all'"),
            },
        }, async (args: { scope?: 'local' | 'global' | 'all' }) => {
            const result = await this.debuggingHandler.handleGetVariables(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Evaluate expression tool
        this.mcpServer!.registerTool('evaluate_expression', {
            description: 'Powerful runtime expression evaluator: Test hypotheses, check computed values, call methods, or inspect object properties in the live debug context. Goes beyond simple variable inspection - evaluate any valid expression in the target language.',
            inputSchema: {
                expression: z.string().describe('Expression to evaluate in the current programming language context'),
            },
        }, async (args: { expression: string }) => {
            const result = await this.debuggingHandler.handleEvaluateExpression(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // ========== Embedded / Cortex-M Tools ==========

        // Read memory tool
        this.mcpServer!.registerTool('read_memory', {
            description: 'Read a range of bytes from the target\'s memory. ' +
                'Use this for inspecting SRAM, Flash, peripheral registers, or the stack. ' +
                'Returns hex dump and/or ASCII representation.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                address: z.string().describe("Memory address as hex string, e.g. '0x20000000'"),
                length: z.number().int().min(1).max(4096).describe('Number of bytes to read (1-4096)'),
                format: z.enum(['hex', 'ascii', 'both']).default('both').describe('Output format'),
            },
        }, async (args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both' }) => {
            const result = await this.debuggingHandler.handleReadMemory(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read core registers tool
        this.mcpServer!.registerTool('read_core_registers', {
            description: 'Read Cortex-M core registers: R0-R12, SP, LR, PC, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK. ' +
                'Essential for analyzing crash state, stack pointers, and processor mode.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleReadCoreRegisters();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Read peripheral register tool
        this.mcpServer!.registerTool('read_peripheral_register', {
            description: 'Read named peripheral registers using SVD data from the Peripheral Inspector extension. ' +
                'Provide a peripheral name (e.g. "GPIOA", "UART0", "SPI1") and optionally a register name. ' +
                'If the Peripheral Inspector is not available, provides guidance on using read_memory instead.',
            annotations: { readOnlyHint: true, destructiveHint: false },
            inputSchema: {
                peripheral: z.string().describe("Peripheral name, e.g. 'GPIOA', 'UART0', 'RCC'"),
                register: z.string().optional().describe("Register name, e.g. 'ODR', 'CR1'. If omitted, lists all registers in the peripheral."),
            },
        }, async (args: { peripheral: string; register?: string }) => {
            const result = await this.debuggingHandler.handleReadPeripheralRegister(args);
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get fault info tool
        this.mcpServer!.registerTool('get_fault_info', {
            description: 'Read and decode Cortex-M fault status registers (CFSR, HFSR, BFAR, MMFAR, DFSR, AFSR). ' +
                'Call this when the target hits a HardFault, BusFault, MemManage, or UsageFault. ' +
                'Returns a human-readable analysis of which fault bits are set and what they mean.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleGetFaultInfo();
            return { content: [{ type: 'text' as const, text: result }] };
        });

        // Get device info tool
        this.mcpServer!.registerTool('get_device_info', {
            description: 'Return information about the connected debug target: session name, debug type, program path, ' +
                'GDB path, GDB server, port, and CMSIS config details.',
            annotations: { readOnlyHint: true, destructiveHint: false },
        }, async () => {
            const result = await this.debuggingHandler.handleGetDeviceInfo();
            return { content: [{ type: 'text' as const, text: result }] };
        });
    }

    /**
     * Setup MCP resources for documentation
     */
    private setupResources() {
        // Add MCP resources for debugging documentation
        this.mcpServer!.registerResource('Debugging Instructions Guide', 'cmsis-debugmcp://docs/debug_instructions', {
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
            this.mcpServer!.registerResource(
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
        this.mcpServer!.registerResource(
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
        this.mcpServer!.registerResource(
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
        // First check if server is already running
        const isRunning = await this.isServerRunning();
        if (isRunning) {
            logger.info(`CMSIS-DebugMCP server is already running on port ${this.port}`);
            return;
        }

        try {
            logger.info(`Starting CMSIS-DebugMCP server on port ${this.port}...`);

            const app = express();

            // Parse JSON body for incoming requests
            app.use(express.json());

            // Streamable HTTP endpoint — handles MCP protocol messages
            app.post('/mcp', async (req: any, res: any) => {
                logger.info('New MCP request received');
                
                // Create a new transport for each request (stateless mode)
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined, // Stateless mode - no session management
                });

                // Clean up transport when response closes
                res.on('close', () => {
                    transport.close();
                    logger.info('MCP transport closed');
                });

                // Close any existing transport before connecting new one.
                // Protocol.close() clears _transport but preserves _requestHandlers
                // (tool registrations), so tools survive across reconnections.
                await this.mcpServer!.close();

                // Connect the MCP server to this transport
                await this.mcpServer!.connect(transport);
                
                // Handle the incoming request
                await transport.handleRequest(req, res, req.body);
            });

            // Legacy SSE endpoint for backward compatibility
            app.get('/sse', async (req: any, res: any) => {
                res.status(410).json({ 
                    error: 'SSE endpoint deprecated', 
                    message: 'Please use POST /mcp endpoint instead',
                    newEndpoint: '/mcp'
                });
            });

            this.httpServer = app.listen(this.port, () => {
                logger.info(`CMSIS-DebugMCP server started successfully on port ${this.port}`);
            });

        } catch (error) {
            logger.error(`Failed to start CMSIS-DebugMCP server`, error);
            throw new Error(`Failed to start CMSIS-DebugMCP server: ${error}`);
        }
    }

    /**
     * Stop the MCP server
     */
    async stop() {
        // Note: With stateless StreamableHTTPServerTransport, transports are closed per-request
        // No need to track and close them manually
        this.transports.clear();

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
     * Get the server endpoint
     */
    getEndpoint(): string {
        return `http://localhost:${this.port}`;
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