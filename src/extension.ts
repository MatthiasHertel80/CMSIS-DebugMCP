// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugMCPServer } from './debugMCPServer';
import { SERVER_VERSION } from './debuggingExecutor';
import { AgentConfigurationManager } from './utils/agentConfigurationManager';
import { clearSvdCache } from './core/svdParser';
import { logger, LogLevel } from './utils/logger';
import { registerSessionStateTracker } from './utils/sessionStateTracker';

let mcpServer: DebugMCPServer | null = null;
let agentConfigManager: AgentConfigurationManager | null = null;

export async function activate(context: vscode.ExtensionContext) {
    // Initialize logging first
    logger.info('CMSIS-DebugMCP extension is now active!');
    logger.logSystemInfo();
    logger.logEnvironment();

    const config = vscode.workspace.getConfiguration('cmsis-debugmcp');
    const timeoutInSeconds = config.get<number>('timeoutInSeconds', 60);
    const serverPort = config.get<number>('serverPort', 3001);
    const dapRequestTimeoutMs = config.get<number>('dapRequestTimeoutMs', 10000);
    const memoryReadTimeoutMs = config.get<number>('memoryReadTimeoutMs', 30000);

    logger.info(`Using timeoutInSeconds: ${timeoutInSeconds} seconds`);
    logger.info(`Using serverPort: ${serverPort}`);
    logger.info(`Using dapRequestTimeoutMs: ${dapRequestTimeoutMs} ms`);
    logger.info(`Using memoryReadTimeoutMs: ${memoryReadTimeoutMs} ms`);

    // Track DAP stopped/continued events so we can answer "is the target
    // currently paused?" reliably, regardless of what activeStackItem says.
    registerSessionStateTracker(context);

    // Drop the parsed-SVD cache when a debug session ends — the next session
    // may target a different device, and the module-level cache in svdParser
    // has no other invalidation path.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession(() => clearSvdCache()),
    );

    // Initialize Agent Configuration Manager
    agentConfigManager = new AgentConfigurationManager(context, timeoutInSeconds, serverPort);

    // Initialize MCP Server
    try {
        logger.info('Starting MCP server initialization...');
        
        mcpServer = new DebugMCPServer(serverPort, timeoutInSeconds, {
            dapRequestMs: dapRequestTimeoutMs,
            memoryReadMs: memoryReadTimeoutMs,
        });
        await mcpServer.initialize();
        await mcpServer.start();

        // The server may have fallen back to an OS-assigned port if the
        // configured port was already in use by another IDE window.
        const actualPort = mcpServer.getActualPort();
        if (actualPort !== serverPort) {
            logger.info(`Configured port ${serverPort} was busy – server is on port ${actualPort}`);
        }
        agentConfigManager.updatePort(actualPort);
        
        const endpoint = mcpServer.getEndpoint();
        logger.info(`CMSIS-DebugMCP server running at: ${endpoint}`);
        vscode.window.showInformationMessage(`CMSIS-DebugMCP server running on ${endpoint}`);

        // Register as a VS Code MCP server definition provider so Copilot
        // discovers this server without a static mcp.json entry (which
        // causes race conditions on startup).
        const mcpUri = vscode.Uri.parse(`${endpoint}/mcp`);
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('cmsis-debugmcp', {
                provideMcpServerDefinitions() {
                    return [
                        new vscode.McpHttpServerDefinition(
                            'CMSIS-DebugMCP',
                            mcpUri,
                            undefined,
                            SERVER_VERSION,
                        ),
                    ];
                },
            }),
        );
        logger.info('Registered MCP server definition provider for VS Code');
    } catch (error) {
        logger.error('Failed to initialize MCP server', error);
        vscode.window.showErrorMessage(`Failed to initialize MCP server: ${error}`);
    }

    // Migrate existing SSE configurations to streamableHttp (for backward compatibility)
    // This only applies to third-party agents (Cline, Cursor) — Copilot uses
    // the native McpServerDefinitionProvider registered above.
    try {
        await agentConfigManager.migrateExistingConfigurations();
    } catch (error) {
        logger.error('Error migrating existing configurations', error);
    }

    // Changing the port has no effect until the server is rebuilt, and the
    // agent configs still point at the old one. Tell the user rather than
    // leaving them with a setting that silently does nothing.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (event) => {
            if (!event.affectsConfiguration('cmsis-debugmcp.serverPort')) {
                return;
            }
            const reload = 'Reload Window';
            const choice = await vscode.window.showInformationMessage(
                'CMSIS-DebugMCP: the server port setting changed. Reload the window to restart the MCP server on the new port.',
                reload,
            );
            if (choice === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }),
    );

    // Register commands
    registerCommands(context);

    // Show post-install popup if needed (with slight delay to allow VS Code to fully load)
    setTimeout(async () => {
        try {
            if (agentConfigManager && await agentConfigManager.shouldShowPopup()) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        } catch (error) {
            logger.error('Error showing post-install popup', error);
        }
    }, 2000);

    logger.info('CMSIS-DebugMCP extension activated successfully');
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Command to manually configure CMSIS-DebugMCP for agents
    const configureAgentsCommand = vscode.commands.registerCommand(
        'cmsis-debugmcp.configureAgents',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showManualConfiguration();
            }
        }
    );

    // Command to show agent selection popup again
    const showPopupCommand = vscode.commands.registerCommand(
        'cmsis-debugmcp.showAgentSelectionPopup',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.showAgentSelectionPopup();
            }
        }
    );

    // Command to reset popup state (for development/testing)
    const resetPopupCommand = vscode.commands.registerCommand(
        'cmsis-debugmcp.resetPopupState',
        async () => {
            if (agentConfigManager) {
                await agentConfigManager.resetPopupState();
                vscode.window.showInformationMessage('CMSIS-DebugMCP popup state has been reset.');
            }
        }
    );

    context.subscriptions.push(
        configureAgentsCommand,
        showPopupCommand,
        resetPopupCommand
        );
}

export async function deactivate() {
    logger.info('CMSIS-DebugMCP extension deactivating...');

    // Clean up MCP server
    if (mcpServer) {
        mcpServer.stop().catch(error => {
            logger.error('Error stopping MCP server', error);
        });
        mcpServer = null;
    }

    logger.info('CMSIS-DebugMCP extension deactivated');
}
