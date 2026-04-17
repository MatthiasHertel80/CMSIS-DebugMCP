// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { DebugState, StackFrame } from './debugState';

/**
 * Interface for debugging execution operations
 */
export interface IDebuggingExecutor {
    startDebugging(workingDirectory: string, config: vscode.DebugConfiguration): Promise<boolean>;
    startDebuggingByName(workingDirectory: string, configurationName: string): Promise<boolean>;
    stopDebugging(session?: vscode.DebugSession): Promise<void>;
    stepOver(): Promise<void>;
    stepInto(): Promise<void>;
    stepOut(): Promise<void>;
    continue(): Promise<void>;
    restart(): Promise<void>;
    addBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    removeBreakpoint(uri: vscode.Uri, line: number): Promise<void>;
    getCurrentDebugState(numNextLines: number): Promise<DebugState>;
    getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any>;
    evaluateExpression(expression: string, frameId: number): Promise<any>;
    getBreakpoints(): readonly vscode.Breakpoint[];
    clearAllBreakpoints(): void;
    hasActiveSession(): Promise<boolean>;
    getActiveSession(): vscode.DebugSession | undefined;
    readMemory(address: string, length: number): Promise<Buffer>;
    readMemoryWord(address: string): Promise<number>;
    readCoreRegisters(): Promise<Record<string, string>>;
    readPeripheralRegister(peripheral: string, register?: string): Promise<string>;
    getFaultInfo(): Promise<string>;
    getDeviceInfo(): Promise<string>;
}

/**
 * Responsible for executing VS Code debugging commands and managing debug sessions
 */
export class DebuggingExecutor implements IDebuggingExecutor {

    /**
     * Start a debugging session
     */
    public async startDebugging(
        workingDirectory: string, 
        config: vscode.DebugConfiguration
    ): Promise<boolean> {
        try {
            if (config.type === 'coreclr') {
                // Open the specific test file instead of the workspace folder
                const testFileUri = vscode.Uri.file(config.program);
                await vscode.commands.executeCommand('vscode.open', testFileUri);
                vscode.commands.executeCommand('testing.debugCurrentFile');
                return true;
            }
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
            return await vscode.debug.startDebugging(workspaceFolder, config);
        } catch (error) {
            throw new Error(`Failed to start debugging: ${error}`);
        }
    }

    /**
     * Start a debugging session by configuration name (for gdbtarget/CMSIS configs)
     * Passes the config name directly to VS Code, letting it resolve from launch.json
     */
    public async startDebuggingByName(
        workingDirectory: string,
        configurationName: string
    ): Promise<boolean> {
        try {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workingDirectory));
            return await vscode.debug.startDebugging(workspaceFolder, configurationName);
        } catch (error) {
            throw new Error(`Failed to start debugging with configuration '${configurationName}': ${error}`);
        }
    }

    /**
     * Stop the debugging session
     */
    public async stopDebugging(session?: vscode.DebugSession): Promise<void> {
        try {
            const activeSession = session || vscode.debug.activeDebugSession;
            if (activeSession) {
                await vscode.debug.stopDebugging(activeSession);
            }
        } catch (error) {
            throw new Error(`Failed to stop debugging: ${error}`);
        }
    }

    /**
     * Execute step over command
     */
    public async stepOver(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await session.customRequest('next', { threadId });
        } catch {
            // Fallback to UI command
            await vscode.commands.executeCommand('workbench.action.debug.stepOver');
        }
    }

    /**
     * Execute step into command
     */
    public async stepInto(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await session.customRequest('stepIn', { threadId });
        } catch {
            await vscode.commands.executeCommand('workbench.action.debug.stepInto');
        }
    }

    /**
     * Execute step out command
     */
    public async stepOut(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await session.customRequest('stepOut', { threadId });
        } catch {
            await vscode.commands.executeCommand('workbench.action.debug.stepOut');
        }
    }

    /**
     * Execute continue command
     */
    public async continue(): Promise<void> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }
        try {
            const threadId = this.getActiveThreadId();
            await session.customRequest('continue', { threadId });
        } catch {
            // Fallback to UI command
            await vscode.commands.executeCommand('workbench.action.debug.continue');
        }
    }

    /**
     * Get the active thread ID from the current stack item or default to 1.
     */
    private getActiveThreadId(): number {
        const activeStackItem = vscode.debug.activeStackItem;
        if (activeStackItem && 'threadId' in activeStackItem) {
            return activeStackItem.threadId;
        }
        return 1; // Default thread for single-core targets
    }

    /**
     * Execute restart command
     */
    public async restart(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.action.debug.restart');
        } catch (error) {
            throw new Error(`Failed to restart: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async addBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoint = new vscode.SourceBreakpoint(
                new vscode.Location(uri, new vscode.Position(line - 1, 0))
            );
            vscode.debug.addBreakpoints([breakpoint]);
        } catch (error) {
            throw new Error(`Failed to add breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async removeBreakpoint(uri: vscode.Uri, line: number): Promise<void> {
        try {
            const breakpoints = vscode.debug.breakpoints.filter(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (breakpoints.length > 0) {
                vscode.debug.removeBreakpoints(breakpoints);
            }
        } catch (error) {
            throw new Error(`Failed to remove breakpoint: ${error}`);
        }
    }

    /**
     * Get current debugging state
     */
    public async getCurrentDebugState(numNextLines: number = 3): Promise<DebugState> {
        const state = new DebugState();
        
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (activeSession) {
                state.sessionActive = true;
                state.updateConfigurationName(activeSession.configuration.name ?? null);
                
                const activeStackItem = vscode.debug.activeStackItem;
                if (activeStackItem && 'frameId' in activeStackItem) {
                    state.updateContext(activeStackItem.frameId, activeStackItem.threadId);
                    
                    // Extract frame name from stack frame
                    await this.extractFrameName(activeSession, activeStackItem.frameId, state);
                    
                    // Get the active editor
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor) {
                        const fileName = activeEditor.document.fileName.split(/[/\\]/).pop() || '';
                        const currentLine = activeEditor.selection.active.line + 1; // 1-based line number
                        const currentLineContent = activeEditor.document.lineAt(activeEditor.selection.active.line).text.trim();
                        
                        // Get next non-empty lines
                        const nextLines = [];
                        let lineOffset = 1;
                        while (nextLines.length < numNextLines && 
                               activeEditor.selection.active.line + lineOffset < activeEditor.document.lineCount) {
                            const lineText = activeEditor.document.lineAt(activeEditor.selection.active.line + lineOffset).text.trim();
                            if (lineText.length > 0) {
                                nextLines.push(lineText);
                            }
                            lineOffset++;
                        }
                        
                        state.updateLocation(
                            activeEditor.document.fileName,
                            fileName,
                            currentLine,
                            currentLineContent,
                            nextLines
                        );
                    }
                }
            }
        } catch (error) {
            console.log('Unable to get debug state:', error);
        }
        
        // Populate breakpoints as compact "fileName:line" strings
        const breakpoints = vscode.debug.breakpoints;
        const formattedBreakpoints = breakpoints
            .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
            .map(bp => {
                const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop() || 'unknown';
                const line = bp.location.range.start.line + 1;
                return `${fileName}:${line}`;
            });
        state.updateBreakpoints(formattedBreakpoints);

        return state;
    }

    /**
     * Extract frame name and stack trace from the current debug session
     */
    private async extractFrameName(session: vscode.DebugSession, frameId: number, state: DebugState): Promise<void> {
        try {
            // Get full stack trace (up to 50 frames)
            const stackTraceResponse = await session.customRequest('stackTrace', {
                threadId: state.threadId,
                startFrame: 0,
                levels: 50
            });

            if (stackTraceResponse?.stackFrames && stackTraceResponse.stackFrames.length > 0) {
                // Extract frame name from current frame
                const currentFrame = stackTraceResponse.stackFrames[0];
                state.updateFrameName(currentFrame.name || null);

                // Build stack trace array
                const stackTrace: StackFrame[] = stackTraceResponse.stackFrames.map((frame: any) => ({
                    name: frame.name || 'unknown',
                    source: frame.source?.path || frame.source?.name || undefined,
                    line: frame.line || undefined,
                    column: frame.column || undefined,
                }));

                state.updateStackTrace(stackTrace);
            }
        } catch (error) {
            console.log('Unable to extract stack info:', error);
            // Set empty values on error
            state.updateFrameName(null);
            state.updateStackTrace([]);
        }
    }

    /**
     * Get variables from the current debug context
     */
    public async getVariables(frameId: number, scope?: 'local' | 'global' | 'all'): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('scopes', { frameId });
            
            if (!response || !response.scopes || response.scopes.length === 0) {
                return { scopes: [] };
            }

            const filteredScopes = response.scopes.filter((scopeItem: any) => {
                if (scope === 'all') {return true;}
                const scopeName = scopeItem.name.toLowerCase();
                if (scope === 'local') {return scopeName.includes('local');}
                if (scope === 'global') {return scopeName.includes('global');}
                return true;
            });

            // Get variables for each scope
            for (const scopeItem of filteredScopes) {
                try {
                    const variablesResponse = await activeSession.customRequest('variables', {
                        variablesReference: scopeItem.variablesReference
                    });
                    scopeItem.variables = variablesResponse.variables || [];
                } catch (scopeError) {
                    scopeItem.variables = [];
                    scopeItem.error = scopeError;
                }
            }

            return { scopes: filteredScopes };
        } catch (error) {
            throw new Error(`Failed to get variables: ${error}`);
        }
    }

    /**
     * Evaluate an expression in the current debug context
     */
    public async evaluateExpression(expression: string, frameId: number): Promise<any> {
        try {
            const activeSession = vscode.debug.activeDebugSession;
            if (!activeSession) {
                throw new Error('No active debug session');
            }

            const response = await activeSession.customRequest('evaluate', {
                expression: expression,
                frameId: frameId,
                context: 'repl'
            });

            return response;
        } catch (error) {
            throw new Error(`Failed to evaluate expression: ${error}`);
        }
    }


    /**
     * Get all active breakpoints
     */
    public getBreakpoints(): readonly vscode.Breakpoint[] {
        return vscode.debug.breakpoints;
    }

    /**
     * Clear all breakpoints
     */
    public clearAllBreakpoints(): void {
        const breakpoints = vscode.debug.breakpoints;
        if (breakpoints.length > 0) {
            vscode.debug.removeBreakpoints(breakpoints);
        }
    }

    /**
     * Check if there's an active debug session that is ready for debugging operations
     */
    public async hasActiveSession(): Promise<boolean> {
        // Quick check first - no session at all
        if (!vscode.debug.activeDebugSession) {
            return false;
        }

        try {
            // Get the current debug state and check if it has location information
            // This is the most reliable way to determine if the debugger is truly ready
            const debugState = await this.getCurrentDebugState();
            
            // A session is ready when it has location info (file name and line number)
            // This means the debugger has attached and we can see where we are in the code
            return debugState.sessionActive && debugState.hasLocationInfo();
        } catch (error) {
            // Any error means session isn't ready (e.g., Python still initializing)
            console.log('Session readiness check failed:', error);
            return false;
        }
    }

    /**
     * Get the active debug session
     */
    public getActiveSession(): vscode.DebugSession | undefined {
        return vscode.debug.activeDebugSession;
    }

    // ========== Embedded / Cortex-M specific methods ==========

    /**
     * Read a range of bytes from target memory.
     * Tries DAP readMemory first, falls back to GDB evaluate.
     */
    public async readMemory(address: string, length: number): Promise<Buffer> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }

        // Normalize address to ensure 0x prefix
        const addr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;

        try {
            // Try DAP readMemory (supported by CDT GDB Adapter / Memory Inspector)
            const response = await session.customRequest('readMemory', {
                memoryReference: addr,
                count: length,
            });
            if (!response.data) {
                throw new Error(`No data returned for address ${addr} (${response.unreadableBytes ?? length} unreadable bytes)`);
            }
            return Buffer.from(response.data, 'base64');
        } catch (dapError) {
            // Fallback: use GDB evaluate to read 32-bit words
            const wordCount = Math.ceil(length / 4);
            const byteValues: number[] = [];
            const debugState = await this.getCurrentDebugState(0);
            const frameOpt: Record<string, number> | undefined = debugState.frameId !== null ? { frameId: debugState.frameId } : undefined;

            for (let w = 0; w < wordCount; w++) {
                const wordAddr = BigInt(addr) + BigInt(w * 4);
                const hexAddr = `0x${wordAddr.toString(16)}`;
                const val = await this.evaluateMemoryWord(session, hexAddr, frameOpt);
                // Little-endian: push 4 bytes
                byteValues.push(val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >>> 24) & 0xFF);
            }

            // Trim to requested length
            return Buffer.from(byteValues.slice(0, length));
        }
    }

    /**
     * Read a single 32-bit word from target memory (little-endian).
     */
    public async readMemoryWord(address: string): Promise<number> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }

        const addr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;

        try {
            const response = await session.customRequest('readMemory', {
                memoryReference: addr,
                count: 4,
            });
            if (!response.data) {
                throw new Error('No data returned');
            }
            const buf = Buffer.from(response.data, 'base64');
            return buf.readUInt32LE(0);
        } catch {
            // Fallback: GDB evaluate
            return await this.evaluateMemoryWord(session, addr);
        }
    }

    /**
     * Evaluate a 32-bit memory word via GDB with multiple fallback strategies.
     * Tries: (1) evaluate with 'watch' context, (2) evaluate with 'repl' context using -exec.
     */
    private async evaluateMemoryWord(
        session: vscode.DebugSession,
        hexAddr: string,
        frameOpt?: Record<string, number>
    ): Promise<number> {
        if (!frameOpt) {
            const debugState = await this.getCurrentDebugState(0);
            frameOpt = debugState.frameId !== null ? { frameId: debugState.frameId } : {};
        }

        // Strategy 1: evaluate expression in watch context
        try {
            const result = await session.customRequest('evaluate', {
                expression: `*(unsigned int*)${hexAddr}`,
                context: 'watch',
                ...frameOpt,
            });
            if (result?.result) {
                const val = this.parseGdbIntResult(result.result);
                if (val !== null) { return val; }
            }
        } catch {
            // Fall through to next strategy
        }

        // Strategy 2: GDB x command via REPL context
        try {
            const result = await session.customRequest('evaluate', {
                expression: `-exec x/1xw ${hexAddr}`,
                context: 'repl',
                ...frameOpt,
            });
            if (result?.result) {
                // GDB x output: "0x20000000:\t0x12345678"
                const match = result.result.match(/:\s*(0x[0-9a-fA-F]+)/);
                if (match) {
                    const val = parseInt(match[1], 16);
                    if (!isNaN(val)) { return val; }
                }
            }
        } catch {
            // Fall through to next strategy
        }

        // Strategy 3: evaluate with hex dereference in repl context
        try {
            const result = await session.customRequest('evaluate', {
                expression: `-exec print/x *(unsigned int*)${hexAddr}`,
                context: 'repl',
                ...frameOpt,
            });
            if (result?.result) {
                // GDB print output: "$1 = 0x12345678"
                const match = result.result.match(/(0x[0-9a-fA-F]+)/);
                if (match) {
                    const val = parseInt(match[1], 16);
                    if (!isNaN(val)) { return val; }
                }
            }
        } catch {
            // All strategies failed
        }

        throw new Error(`Failed to read memory at ${hexAddr} — all GDB strategies exhausted`);
    }

    /**
     * Parse a GDB integer result that may be hex (0x...) or decimal.
     * Returns null if unparseable.
     */
    private parseGdbIntResult(raw: string): number | null {
        const trimmed = raw.trim();
        if (!trimmed) { return null; }
        const val = trimmed.startsWith('0x') || trimmed.startsWith('0X')
            ? parseInt(trimmed, 16)
            : parseInt(trimmed, 10);
        return isNaN(val) ? null : val;
    }

    /**
     * Read Cortex-M core registers (R0-R15, xPSR, MSP, PSP, CONTROL, FAULTMASK, BASEPRI, PRIMASK).
     */
    public async readCoreRegisters(): Promise<Record<string, string>> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }

        const registerNames = [
            'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7',
            'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc',
            'xpsr', 'msp', 'psp', 'control', 'faultmask', 'basepri', 'primask',
        ];

        const debugState = await this.getCurrentDebugState(0);
        const results: Record<string, string> = {};

        for (const reg of registerNames) {
            try {
                const response = await session.customRequest('evaluate', {
                    expression: `$${reg}`,
                    context: 'watch',
                    ...(debugState.frameId !== null ? { frameId: debugState.frameId } : {}),
                });
                results[reg] = response.result;
            } catch {
                results[reg] = '<unavailable>';
            }
        }
        return results;
    }

    /**
     * Read peripheral register(s) using the Peripheral Inspector or memory fallback.
     */
    public async readPeripheralRegister(peripheral: string, register?: string): Promise<string> {
        // Dynamic import to avoid hard dependency at module level
        const { tryReadPeripheralViaExtension, readPeripheralViaMemory } = await import('./core/peripheralReader.js');

        // Try the Peripheral Inspector extension first
        const piResult = await tryReadPeripheralViaExtension(peripheral, register);
        if (piResult !== null) {
            return piResult;
        }

        // Fallback to memory-based read
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }
        const debugState = await this.getCurrentDebugState(0);
        return readPeripheralViaMemory(session, peripheral, register, debugState.frameId);
    }

    /**
     * Read and decode Cortex-M fault status registers.
     */
    public async getFaultInfo(): Promise<string> {
        const { FAULT_REGISTER_ADDRESSES, decodeFaultRegisters } = await import('./core/faultDecoder.js');

        const CFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.CFSR);
        const HFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.HFSR);
        const DFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.DFSR);
        const MMFAR = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.MMFAR);
        const BFAR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.BFAR);
        const AFSR  = await this.readMemoryWord(FAULT_REGISTER_ADDRESSES.AFSR);

        return decodeFaultRegisters({ CFSR, HFSR, DFSR, MMFAR, BFAR, AFSR });
    }

    /**
     * Return information about the connected debug target.
     */
    public async getDeviceInfo(): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) { throw new Error('No active debug session'); }

        const config = session.configuration;
        const info: Record<string, string> = {
            'Session name': session.name,
            'Debug type': config.type || '<unknown>',
            'Program': config.program || '<unknown>',
            'GDB': config.gdb || '<default>',
            'Server': config.target?.server || '<unknown>',
            'Port': config.target?.port || '<unknown>',
        };

        if (config.cmsis?.cbuildRunFile) {
            info['cbuild-run'] = config.cmsis.cbuildRunFile;
        }

        let result = '=== Debug Session Info ===\n';
        for (const [key, value] of Object.entries(info)) {
            result += `  ${key}: ${value}\n`;
        }
        return result;
    }
}
