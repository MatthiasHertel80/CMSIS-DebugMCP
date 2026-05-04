// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { IDebugConfigurationManager } from './utils/debugConfigurationManager';
import { DebugState } from './debugState';
import { IDebuggingExecutor } from './debuggingExecutor';
import { HardwareTimeoutError } from './utils/timeout';
import { logger } from './utils/logger';

const HARD_HANDLER_CAP_MS = 60_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Wrap a handler body in an absolute deadline. On overshoot the wrapper
 * returns a structured timeout string rather than hanging the MCP call.
 * The underlying work may still be running on the VS Code side — there is
 * no way to cancel a DAP request mid-flight — but the agent regains control.
 */
async function withHandlerTimeout<T extends string>(
    label: string,
    timeoutMs: number | undefined,
    fn: () => Promise<T>,
): Promise<string> {
    const ms = (timeoutMs && timeoutMs > 0)
        ? Math.min(timeoutMs, HARD_HANDLER_CAP_MS)
        : DEFAULT_HANDLER_TIMEOUT_MS;

    let timer: NodeJS.Timeout | undefined;
    const fenced = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
            resolve(`'${label}' did not complete within ${ms} ms (handler-level cap). ` +
                `The DAP probe or target may be unresponsive — call get_session_status / ` +
                `check_target_connection to confirm. Note: the underlying request may still ` +
                `be running on the server; consider restart_debugging if subsequent calls also stall.`);
        }, ms);
    });

    const work = fn().catch((err) => {
        // Surface failures as text so the race always yields a string.
        return `Error in '${label}': ${err instanceof Error ? err.message : String(err)}`;
    });

    try {
        return await Promise.race([work, fenced]);
    } finally {
        if (timer) { clearTimeout(timer); }
    }
}

/**
 * Interface for debugging handler operations
 */
export interface IDebuggingHandler {
    handleStartDebugging(args: { fileFullPath?: string; workingDirectory: string; testName?: string; configurationName?: string; timeoutMs?: number }): Promise<string>;
    handleStopDebugging(): Promise<string>;
    handleStepOver(args?: { timeoutMs?: number }): Promise<string>;
    handleStepInto(args?: { timeoutMs?: number }): Promise<string>;
    handleStepOut(args?: { timeoutMs?: number }): Promise<string>;
    handleContinue(args?: { timeoutMs?: number }): Promise<string>;
    handlePause(args?: { timeoutMs?: number }): Promise<string>;
    handleRestart(args?: { timeoutMs?: number }): Promise<string>;
    handleAddBreakpoint(args: { fileFullPath: string; lineContent: string }): Promise<string>;
    handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string>;
    handleClearAllBreakpoints(): Promise<string>;
    handleListBreakpoints(): Promise<string>;
    handleGetVariables(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string>;
    handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string>;
    handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string>;
    handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string>;
    handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string>;
    handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string>;
    handleGetDeviceInfo(): Promise<string>;
    handleCheckTargetConnection(): Promise<string>;
    handleGetSessionStatus(): Promise<string>;
    handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string>;
    handleGetThreads(args?: { timeoutMs?: number }): Promise<string>;
    handleGetFrameVariables(args: { frameId: number; scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string>;
    handleCmsisCommand(args: { action: CmsisAction; timeoutMs?: number }): Promise<string>;
}

export type CmsisAction =
    | 'build'
    | 'load'
    | 'erase'
    | 'load_and_run'
    | 'load_and_debug'
    | 'attach'
    | 'detach'
    | 'stop_run';

/**
 * Handles debugging operations using the executor and configuration manager
 */
export class DebuggingHandler implements IDebuggingHandler {
    private readonly numNextLines: number = 3;
    private readonly executionDelay: number = 300; // ms to wait for debugger updates
    private readonly timeoutInSeconds: number;

    constructor(
        private readonly executor: IDebuggingExecutor,
        private readonly configManager: IDebugConfigurationManager,
        timeoutInSeconds: number
    ) {
        this.timeoutInSeconds = timeoutInSeconds;
    }

    /**
     * Start a debugging session
     */
    public async handleStartDebugging(args: {
        fileFullPath?: string;
        workingDirectory: string;
        testName?: string;
        configurationName?: string;
        timeoutMs?: number;
    }): Promise<string> {
        const { fileFullPath, workingDirectory, testName, configurationName } = args;

        // Pre-check: refuse to start a second session on top of an active one.
        // Otherwise we end up with two debug sessions racing and the MCP tools
        // become unpredictable. The agent should explicitly stop or restart.
        if (this.executor.hasDebugSession()) {
            const status = await this.executor.getSessionStatus();
            return `A debug session is already active (name='${status.sessionName ?? '?'}', ` +
                `state=${status.state}). Refusing to start a second session. ` +
                `Use stop_debugging first, or call restart_debugging to reuse the current session, ` +
                `or proceed directly with inspection tools (get_variables_values, read_memory, …).`;
        }

        try {
            let selectedConfigName = configurationName ?? await this.configManager.promptForConfiguration(workingDirectory);
            
            // For named configurations (e.g. gdbtarget/CMSIS), pass the name directly
            // to vscode.debug.startDebugging without requiring fileFullPath
            if (selectedConfigName && selectedConfigName !== 'Default Configuration') {
                const started = await this.executor.startDebuggingByName(workingDirectory, selectedConfigName);
                if (started) {
                    const sessionActive = await this.waitForActiveDebugSession();
                    if (!sessionActive) {
                        throw new Error('Debug session started but failed to become active within timeout period');
                    }
                    const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                    const target = fileFullPath || selectedConfigName;
                    return `Debug session started successfully for: ${target} using configuration '${selectedConfigName}'. Current state: ${currentState.toString()}`;
                } else {
                    throw new Error(`Failed to start debug session with configuration '${selectedConfigName}'.`);
                }
            }

            if (!fileFullPath) {
                throw new Error('fileFullPath is required when no named configuration is provided.');
            }

            // Get debug configuration from launch.json or create default
            const debugConfig = await this.configManager.getDebugConfig(
                workingDirectory, 
                fileFullPath, 
                selectedConfigName,
                testName
            );

            const started = await this.executor.startDebugging(workingDirectory, debugConfig);
            if (started) {
                // Wait for debug session to become active using exponential backoff
                const sessionActive = await this.waitForActiveDebugSession();
                
                if (!sessionActive) {
                    throw new Error('Debug session started but failed to become active within timeout period');
                }
                
                // return also the current state
                const configInfo = selectedConfigName ? ` using configuration '${selectedConfigName}'` : ' with default configuration';
                const testInfo = testName ? ` (test: ${testName})` : '';
                const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
                return `Debug session started successfully for: ${fileFullPath}${configInfo}${testInfo}. Current state: ${currentState.toString()}`;
            } else {
                throw new Error('Failed to start debug session. Make sure the appropriate language extension is installed.');
            }
        } catch (error) {
            throw new Error(`Error starting debug session: ${error}`);
        }
    }

    /**
     * Stop the current debugging session
     */
    public async handleStopDebugging(): Promise<string> {
        try {
            // Use the synchronous session-existence check rather than the
            // stopped-state gate: stop_debugging must work even when the
            // target is currently running or the probe is unresponsive.
            if (!this.executor.hasDebugSession()) {
                return 'No active debug session to stop';
            }

            await this.executor.stopDebugging();

            // Add drill-down reminder
            return 'Debug session stopped successfully\n\n' + this.getRootCauseAnalysisCheckpointMessage();
        } catch (error) {
            throw new Error(`Error stopping debug session: ${error}`);
        }
    }

    /**
     * Clear all breakpoints
     */
    public async handleClearAllBreakpoints(): Promise<string> {
        try {
            const breakpointCount = this.executor.getBreakpoints().length;
            
            if (breakpointCount === 0) {
                return 'No breakpoints to clear';
            }

            this.executor.clearAllBreakpoints();
            return `Successfully cleared ${breakpointCount} breakpoint(s)`;
        } catch (error) {
            throw new Error(`Error clearing breakpoints: ${error}`);
        }
    }

    /**
     * Throw an actionable error if the session is not in a state where
     * inspection/step/continue is valid. Replaces the historical vague
     * "Debug session is not ready" message with something that tells the
     * agent exactly which of the five session states it is in and what to
     * do next — and points it at `get_session_status` for confirmation.
     */
    private async ensureStoppedSession(operation: string): Promise<void> {
        if (await this.executor.hasActiveSession()) {
            return;
        }
        const status = await this.executor.getSessionStatus();
        let hint: string;
        switch (status.state) {
            case 'no-session':
                hint = 'No active debug session. Call start_debugging first.';
                break;
            case 'initializing':
                hint = 'The debug adapter is still starting. Wait briefly and retry; the session has not torn down.';
                break;
            case 'running':
                hint = 'The target is currently running. Add a breakpoint or wait for the previous continue/step to stop before issuing another inspection or step command.';
                break;
            case 'unresponsive':
                hint = 'The probe/GDB server is unresponsive. Call check_target_connection to confirm, then restart_debugging or stop_debugging.';
                break;
            case 'stopped':
                // Race: status flipped between the gate and the status query.
                hint = 'Session reports stopped — please retry the operation.';
                break;
        }
        throw new Error(
            `Cannot ${operation}: session state is '${status.state}'. ${hint} ` +
            `Use get_session_status for a definitive, never-failing classification.`
        );
    }

    /**
     * Execute step over command(s)
     */
    public async handleStepOver(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step over');
            await this.executor.stepOver(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_over');
        } catch (error) {
            throw new Error(`Error executing step over: ${error}`);
        }
    }

    /**
     * Execute step into command
     */
    public async handleStepInto(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step into');
            await this.executor.stepInto(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_into');
        } catch (error) {
            throw new Error(`Error executing step into: ${error}`);
        }
    }

    /**
     * Execute step out command
     */
    public async handleStepOut(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('step out');
            await this.executor.stepOut(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'step_out');
        } catch (error) {
            throw new Error(`Error executing step out: ${error}`);
        }
    }

    /**
     * Continue execution
     */
    public async handleContinue(args?: { timeoutMs?: number }): Promise<string> {
        try {
            await this.ensureStoppedSession('continue execution');
            await this.executor.continue(args?.timeoutMs);
            const result = await this.waitForTargetStopped(args?.timeoutMs);
            return await this.formatAfterExecutionWithHeal(result, 'continue_execution');
        } catch (error) {
            throw new Error(`Error executing continue: ${error}`);
        }
    }

    /**
     * Wrapper around formatAfterExecution that adds an automatic recovery
     * step on timeout: pause the running target, then report where its PC
     * actually is. Saves the agent a round-trip when the breakpoint wasn't hit.
     */
    private async formatAfterExecutionWithHeal(
        result: { state: DebugState; timedOut: boolean; sessionEnded: boolean },
        op: string
    ): Promise<string> {
        const base = this.formatAfterExecution(result, op);
        if (!result.timedOut || result.sessionEnded) {
            return base;
        }
        const recovery = await this.attemptRecoveryAfterTimeout(op);
        return `${base}${recovery}`;
    }

    /**
     * Pause a running target. Use this when you want to inspect state but
     * the target is currently executing (and DAP reads would be rejected).
     * No-op when the target is already stopped.
     */
    public async handlePause(args?: { timeoutMs?: number }): Promise<string> {
        if (!this.executor.hasDebugSession()) {
            throw new Error('No active debug session. Start debugging first.');
        }
        const status = await this.executor.getSessionStatus();
        if (status.state === 'stopped') {
            return `Target is already stopped (reason: ${status.detail ?? 'n/a'}). No pause needed — proceed with inspection tools.`;
        }
        if (status.state === 'unresponsive') {
            return `Cannot pause: probe/GDB server is unresponsive. Call check_target_connection or restart_debugging.`;
        }
        if (status.state === 'no-session') {
            throw new Error('No active debug session.');
        }
        if (status.state === 'initializing') {
            return `Cannot pause yet: session is still initializing. Wait briefly and retry.`;
        }

        // state === 'running' — issue the pause and wait for stop
        await this.executor.pause(args?.timeoutMs);
        const result = await this.waitForTargetStopped(args?.timeoutMs);
        if (result.timedOut) {
            return `Pause requested but target did not stop within the timeout. ` +
                `Probe may be unresponsive — call get_session_status / check_target_connection.`;
        }
        if (result.sessionEnded) {
            return `Pause requested but the debug session ended. The target may have crashed.`;
        }
        return `Target paused. ${result.state.toString()}`;
    }

    /**
     * Restart the debugging session
     */
    public async handleRestart(_args?: { timeoutMs?: number }): Promise<string> {
        try {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session to restart');
            }

            await this.executor.restart();

            // Wait for the debug session to become active again after restart.
            // The probe may take several seconds to reprogram/reset the target;
            // the fixed 300ms delay we previously used was far too optimistic
            // for embedded hardware and frequently returned before the session
            // was usable, causing the very next tool call to fail.
            const sessionActive = await this.waitForActiveDebugSession();
            if (!sessionActive) {
                throw new Error(
                    'Debug session restart issued but target did not become ready within the ' +
                    `${this.timeoutInSeconds}s timeout. The probe or target may be unresponsive.`
                );
            }

            return 'Debug session restarted successfully';
        } catch (error) {
            throw new Error(`Error restarting debug session: ${error}`);
        }
    }

    /**
     * Add a breakpoint at specified location
     */
    public async handleAddBreakpoint(args: { fileFullPath: string; lineContent: string }): Promise<string> {
        const { fileFullPath, lineContent } = args;

        // VS Code's breakpoint API works regardless of session state, but on
        // embedded targets the actual binding to the GDB stub typically only
        // succeeds when the target is stopped. Add a hint so the agent can
        // pause and retry / inspect later if it tried during a free run.
        let runningHint = '';
        if (this.executor.hasDebugSession()) {
            const status = await this.executor.getSessionStatus();
            if (status.state === 'running' || status.state === 'unresponsive') {
                runningHint = ` (note: session state is '${status.state}'. The breakpoint was queued, but ` +
                    `binding to the target typically requires a stopped state — verify with list_breakpoints ` +
                    `after the next stop, or stop_debugging / pause first if it does not bind.)`;
            }
        }

        try {
            // Find the line number containing the line content
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileFullPath));
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            const matchingLineNumbers: number[] = [];
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(lineContent)) {
                    matchingLineNumbers.push(i + 1); // Convert to 1-based line numbers
                }
            }
            
            if (matchingLineNumbers.length === 0) {
                throw new Error(`Could not find any lines containing: ${lineContent}`);
            }
            
            const uri = vscode.Uri.file(fileFullPath);
            
            // Add breakpoints to all matching lines
            for (const lineNumber of matchingLineNumbers) {
                await this.executor.addBreakpoint(uri, lineNumber);
            }
            
            if (matchingLineNumbers.length === 1) {
                return `Breakpoint added at ${fileFullPath}:${matchingLineNumbers[0]}${runningHint}`;
            } else {
                const linesList = matchingLineNumbers.join(', ');
                return `Breakpoints added at ${matchingLineNumbers.length} locations in ${fileFullPath}: lines ${linesList}${runningHint}`;
            }
        } catch (error) {
            throw new Error(`Error adding breakpoint: ${error}`);
        }
    }

    /**
     * Remove a breakpoint from specified location
     */
    public async handleRemoveBreakpoint(args: { fileFullPath: string; line: number }): Promise<string> {
        const { fileFullPath, line } = args;
        
        try {
            const uri = vscode.Uri.file(fileFullPath);
            
            // Check if breakpoint exists at this location
            const breakpoints = this.executor.getBreakpoints();
            const existingBreakpoint = breakpoints.find(bp => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    return bp.location.uri.toString() === uri.toString() && 
                           bp.location.range.start.line === line - 1;
                }
                return false;
            });
            
            if (!existingBreakpoint) {
                return `No breakpoint found at ${fileFullPath}:${line}`;
            }
            
            await this.executor.removeBreakpoint(uri, line);
            return `Breakpoint removed from ${fileFullPath}:${line}`;
        } catch (error) {
            throw new Error(`Error removing breakpoint: ${error}`);
        }
    }

    /**
     * List all active breakpoints
     */
    public async handleListBreakpoints(): Promise<string> {
        try {
            const breakpoints = this.executor.getBreakpoints();
            
            if (breakpoints.length === 0) {
                return 'No breakpoints currently set';
            }

            let breakpointList = 'Active Breakpoints:\n';
            breakpoints.forEach((bp, index) => {
                if (bp instanceof vscode.SourceBreakpoint) {
                    const fileName = bp.location.uri.fsPath.split(/[/\\]/).pop();
                    const line = bp.location.range.start.line + 1;
                    breakpointList += `${index + 1}. ${fileName}:${line}\n`;
                } else if (bp instanceof vscode.FunctionBreakpoint) {
                    breakpointList += `${index + 1}. Function: ${bp.functionName}\n`;
                }
            });

            return breakpointList;
        } catch (error) {
            throw new Error(`Error listing breakpoints: ${error}`);
        }
    }

    /**
     * Get variables from current debug context
     */
    public async handleGetVariables(args: { scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string> {
        const { scope = 'all', timeoutMs } = args;

        return withHandlerTimeout('get_variables_values', timeoutMs, async () => {
            await this.ensureStoppedSession('read variables');

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            let variablesData = await this.executor.getVariables(activeStackItem.frameId, scope, timeoutMs);

            // If 'global' scope was requested but not available, fall back to returning all scopes
            let globalFallback = false;
            if (scope === 'global' && (!variablesData.scopes || variablesData.scopes.length === 0)) {
                variablesData = await this.executor.getVariables(activeStackItem.frameId, 'all', timeoutMs);
                globalFallback = true;
            }

            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return 'No variable scopes available at current execution point.';
            }

            let variablesInfo = '';
            if (globalFallback) {
                variablesInfo += 'Note: No dedicated "Global" scope is available from this debug adapter. Showing all available scopes instead. Use evaluate_expression to inspect specific global variables by name.\n\n';
            }
            variablesInfo += 'Variables:\n==========\n\n';

            for (const scopeItem of variablesData.scopes) {
                variablesInfo += `${scopeItem.name}:\n`;
                
                if (scopeItem.error) {
                    variablesInfo += `  Error retrieving variables: ${scopeItem.error}\n`;
                } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                    for (const variable of scopeItem.variables) {
                        variablesInfo += `  ${variable.name}: ${variable.value}`;
                        if (variable.type) {
                            variablesInfo += ` (${variable.type})`;
                        }
                        variablesInfo += '\n';
                    }
                } else {
                    variablesInfo += '  No variables in this scope\n';
                }
                
                variablesInfo += '\n';
            }

            return variablesInfo;
        });
    }

    /**
     * Evaluate an expression in current debug context
     */
    public async handleEvaluateExpression(args: { expression: string; timeoutMs?: number }): Promise<string> {
        const { expression, timeoutMs } = args;

        return withHandlerTimeout('evaluate_expression', timeoutMs, async () => {
            await this.ensureStoppedSession('evaluate expression');

            const activeStackItem = vscode.debug.activeStackItem;
            if (!activeStackItem || !('frameId' in activeStackItem)) {
                throw new Error('No active stack frame. Make sure execution is paused at a breakpoint.');
            }

            const response = await this.executor.evaluateExpression(expression, activeStackItem.frameId, timeoutMs);

            if (response && response.result !== undefined) {
                let resultText = `Expression: ${expression}\n`;
                resultText += `Result: ${response.result}`;
                if (response.type) {
                    resultText += ` (${response.type})`;
                }

                return resultText;
            } else {
                throw new Error('Failed to evaluate expression');
            }
        });
    }

    /**
     * Get current debug state
     */
    public async getCurrentDebugState(): Promise<DebugState> {
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Check if debugging session is active
     */
    public async isDebuggingActive(): Promise<boolean> {
        return await this.executor.hasActiveSession();
    }

    /**
     * Wait for debug session to become active using exponential backoff starting from 1 second
     */
    private async waitForActiveDebugSession(overrideMs?: number): Promise<boolean> {
        const baseDelay = 1000; // Start with 1 second
        const maxDelay = 10000; // Cap at 10 seconds
        const cap = 60_000;
        const def = this.timeoutInSeconds * 1000;
        const totalMs = (overrideMs && overrideMs > 0) ? Math.min(overrideMs, cap) : Math.min(def, cap);

        const startTime = Date.now();
        let attempt = 0;

        while (Date.now() - startTime < totalMs) {
            if (await this.executor.hasActiveSession()) {
                logger.info('Debug session is now active!');
                return true;
            }
            
            logger.info(`[Attempt ${attempt + 1}] Waiting for debug session to become active...`);

            // Calculate delay using exponential backoff with jitter
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200; // Add up to 200ms jitter
            
            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
            attempt++;
        }
        
        return false; // Timeout reached
    }

    /**
     * Wait for the target to stop after a continue/step command.
     * Uses vscode.debug.onDidChangeActiveStackItem which fires when the debugger
     * stops and a stack frame becomes available — safe for embedded targets.
     *
     * Returns both the state snapshot and whether the wait timed out so that
     * callers can report a clear "target still running / probe stalled" message
     * instead of silently returning a stale state.
     */
    private async waitForTargetStopped(overrideMs?: number): Promise<{ state: DebugState; timedOut: boolean; sessionEnded: boolean }> {
        return new Promise((resolve) => {
            const cap = 60_000;
            const def = this.timeoutInSeconds * 1000;
            const timeoutMs = (overrideMs && overrideMs > 0) ? Math.min(overrideMs, cap) : Math.min(def, cap);
            let settled = false;
            let sessionEnded = false;
            let timedOut = false;

            const settle = async () => {
                if (settled) { return; }
                settled = true;
                stackDisposable.dispose();
                sessionDisposable.dispose();
                clearTimeout(timer);
                // Small delay to let VS Code update the active editor/cursor
                await new Promise(r => setTimeout(r, 300));
                const state = await this.executor.getCurrentDebugState(this.numNextLines);
                resolve({ state, timedOut, sessionEnded });
            };

            // Listen for when a stack frame becomes active (= target stopped)
            const stackDisposable = vscode.debug.onDidChangeActiveStackItem(() => {
                settle();
            });

            // Also listen for session termination
            const sessionDisposable = vscode.debug.onDidTerminateDebugSession(() => {
                sessionEnded = true;
                settle();
            });

            // Timeout fallback
            const timer = setTimeout(() => {
                timedOut = true;
                logger.warn(`waitForTargetStopped: target did not stop within ${timeoutMs}ms`);
                settle();
            }, timeoutMs);
        });
    }

    /**
     * Format the result of a step/continue command, annotating timeouts and
     * session termination so the MCP client sees an unambiguous outcome.
     */
    private formatAfterExecution(result: { state: DebugState; timedOut: boolean; sessionEnded: boolean }, op: string): string {
        const body = result.state.toString();
        if (result.sessionEnded) {
            return `${body}\n\n⚠️ Debug session ended during '${op}'. The target may have run to completion, crashed, or lost its connection.`;
        }
        if (result.timedOut) {
            return `${body}\n\n⚠️ '${op}' did not complete within ${this.timeoutInSeconds}s. ` +
                'The target is still running or the probe is unresponsive. ' +
                'Consider adding a breakpoint, checking the hardware connection, or calling check_target_connection.';
        }
        return body;
    }

    /**
     * Recovery on a step/continue timeout: pause the running target, wait
     * briefly for it to stop, then report where the PC actually is. Lets the
     * agent see that the breakpoint was never hit because, say, the firmware
     * is sitting in a polling loop, an ISR, or has wandered off into the weeds.
     *
     * Returns a human-readable summary appended to the timeout message. Best
     * effort — if pause itself fails the original message stands.
     */
    private async attemptRecoveryAfterTimeout(op: string): Promise<string> {
        const lines: string[] = [];
        lines.push(`\n🩹 Recovery attempt: target did not stop on its own — issuing DAP pause to find out where it is.`);
        try {
            // Short timeout for the pause itself; we don't want to compound the wait.
            await this.executor.pause(5_000);
            // Wait for the stop event to propagate.
            const recovered = await this.waitForTargetStopped(5_000);
            if (recovered.sessionEnded) {
                lines.push(`Pause issued but the debug session ended. The target may have crashed during '${op}'.`);
                return lines.join('\n');
            }
            if (recovered.timedOut) {
                lines.push(`Pause did not produce a stop event within 5s — probe/GDB server may be unresponsive. ` +
                    `Call check_target_connection, then restart_debugging if needed.`);
                return lines.join('\n');
            }

            // Read PC and current frame to localise the firmware.
            let pcText = '<unavailable>';
            try {
                const regs = await this.executor.readCoreRegisters(5_000);
                if (regs.pc) { pcText = this.normalizeRegToHex(regs.pc); }
            } catch (err) {
                pcText = `<read failed: ${err instanceof Error ? err.message : String(err)}>`;
            }

            const state = recovered.state;
            const frame = state.frameName ? ` in ${state.frameName}` : '';
            const loc = state.fileName && state.currentLine !== null
                ? ` at ${state.fileName}:${state.currentLine}`
                : '';
            lines.push(`Paused successfully. PC = ${pcText}${frame}${loc}.`);
            if (state.currentLineContent) {
                lines.push(`  Current line: ${state.currentLineContent}`);
            }
            lines.push(`The breakpoint you expected was not hit — the firmware did not reach it. ` +
                `Verify the breakpoint location, check the call stack with get_call_stack, ` +
                `or step from here with step_over / continue_execution.`);
            return lines.join('\n');
        } catch (err) {
            lines.push(`Pause failed: ${err instanceof Error ? err.message : String(err)}. ` +
                `Probe / GDB server may be wedged — call check_target_connection.`);
            return lines.join('\n');
        }
    }

    /**
     * Wait for debugger state to change from the initial state using exponential backoff
     */
    private async waitForStateChange(beforeState: DebugState): Promise<DebugState> {
        const baseDelay = 1000; // Start with 1 second
        const maxDelay = 1000; // Cap at 1 second
        const startTime = Date.now();
        let attempt = 0;
                
        while (Date.now() - startTime < this.timeoutInSeconds * 1000) {
            const currentState = await this.executor.getCurrentDebugState(this.numNextLines);
            
            if (this.hasStateChanged(beforeState, currentState)) {
                return currentState;
            }
            
            // If session ended, return immediately
            if (!currentState.sessionActive) {
                return currentState;
            }
            
            logger.info(`[Attempt ${attempt + 1}] Waiting for debugger state to change...`);

            // Calculate delay using exponential backoff with jitter (same as waitForActiveDebugSession)
            const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
            const jitteredDelay = delay + Math.random() * 200; // Add up to 200ms jitter

            await new Promise(resolve => setTimeout(resolve, jitteredDelay));
            attempt++;
        }
        
        // If we timeout, return the current state (might be unchanged)
        logger.info('State change detection timed out, returning current state');
        return await this.executor.getCurrentDebugState(this.numNextLines);
    }

    /**
     * Determine if the debugger state has meaningfully changed
     */
    private hasStateChanged(beforeState: DebugState, afterState: DebugState): boolean {
        if (beforeState.hasLocationInfo() && !afterState.hasLocationInfo() && afterState.sessionActive) {
            return false;
        }

        // If session status changed, that's a meaningful change
        if (beforeState.sessionActive !== afterState.sessionActive) {
            return true;
        }
        
        // If session is no longer active, that's a change
        if (!afterState.sessionActive) {
            return true;
        }
        
        // If either state lacks location info, compare what we can
        if (!beforeState.hasLocationInfo() || !afterState.hasLocationInfo()) {
            // If one has location info and the other doesn't, that's a change
            return beforeState.hasLocationInfo() !== afterState.hasLocationInfo();
        }
        
        // Compare file paths - if we moved to a different file, that's a change
        if (beforeState.fileFullPath !== afterState.fileFullPath) {
            return true;
        }
        
        // Compare line numbers - if we moved to a different line, that's a change
        if (beforeState.currentLine !== afterState.currentLine) {
            return true;
        }
        
        // Compare frame names - if we moved to a different function/method, that's a change
        if (beforeState.frameName !== afterState.frameName) {
            return true;
        }
        
        // Compare frame IDs - internal frame change
        if (beforeState.frameId !== afterState.frameId) {
            return true;
        }
        
        // If we get here, no meaningful change was detected
        return false;
    }

    /**
     * Get the universal drill-down reminder message
     */
    private getRootCauseAnalysisCheckpointMessage(): string {
        return `⚠️ **ROOT CAUSE ANALYSIS CHECKPOINT**

Before concluding your debugging session:

❓ **CRITICAL QUESTION:** Have you found the ROOT CAUSE or just a SYMPTOM?

🔍 **If you only identified WHERE it went wrong:**
- Variable is null/undefined
- Function returned unexpected value  
- Error occurred at specific line
- Condition evaluated incorrectly

➡️ **You likely found a SYMPTOM - Continue debugging!**

ROOT CAUSE means understanding WHY the issue occurred in the first place, for example due to:
- Incorrect variable initialization
- Logic error in function implementation
- Missing error handling
- Faulty assumptions in conditions

REQUIRED NEXT STEPS:
1. Use 'add_breakpoint' to set breakpoints at investigation points
2. Use 'start_debugging' to trace from the beginning
3. Investigate WHY the issue occurred, not just WHAT happened
4. Repeat the process as necessary until the ROOT CAUSE is identified`;
    }

    // ========== Embedded / Cortex-M tool handlers ==========

    /**
     * Read target memory
     */
    public async handleReadMemory(args: { address: string; length: number; format?: 'hex' | 'ascii' | 'both'; timeoutMs?: number }): Promise<string> {
        const { address, length, format = 'both', timeoutMs } = args;

        return withHandlerTimeout('read_memory', timeoutMs, async () => {
            await this.ensureStoppedSession('read memory');

            const data = await this.executor.readMemory(address, length, timeoutMs);

            // Normalize and parse address using BigInt to handle full 32-bit range
            const addrStr = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;
            const baseAddr = BigInt(addrStr);

            let result = `Memory at ${addrStr} (${length} bytes):\n`;

            if (format === 'hex' || format === 'both') {
                result += '\nHex:\n';
                for (let i = 0; i < data.length; i += 16) {
                    const slice = data.subarray(i, Math.min(i + 16, data.length));
                    const addr = (baseAddr + BigInt(i)).toString(16).padStart(8, '0');
                    const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    result += `  0x${addr}: ${hex}\n`;
                }
            }

            if (format === 'ascii' || format === 'both') {
                result += '\nASCII:\n  ';
                for (let i = 0; i < data.length; i++) {
                    const ch = data[i];
                    result += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : '.';
                    if ((i + 1) % 64 === 0) { result += '\n  '; }
                }
                result += '\n';
            }

            return result;
        });
    }

    /**
     * Normalize a GDB register value string to hex format.
     * Converts pure decimal to 0x hex, strips symbol annotations from hex values.
     * Keeps decoded formats (e.g. "[ Z C GE=0 ]") as-is.
     */
    private normalizeRegToHex(raw: string): string {
        const trimmed = raw.trim();
        if (!trimmed || trimmed === '<?>') { return trimmed; }

        // Decoded format like "[ Z C GE=0 EXC=0 T ]" — keep as-is
        if (trimmed.startsWith('[')) { return trimmed; }

        // Already hex (0x…) — strip symbol annotation like " <main+12>"
        if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
            const hexMatch = trimmed.match(/^(0x[0-9a-fA-F]+)/);
            return hexMatch ? hexMatch[1] : trimmed;
        }

        // Pure decimal — convert to 0x hex (32-bit unsigned)
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 0) {
            return '0x' + (num >>> 0).toString(16).padStart(8, '0');
        }

        return trimmed;
    }

    /**
     * Read Cortex-M core registers
     */
    public async handleReadCoreRegisters(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('read_core_registers', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('read core registers');

            const regs = await this.executor.readCoreRegisters(args?.timeoutMs);

            let result = 'Core Registers:\n';
            const rows: string[][] = [
                ['r0', 'r1', 'r2', 'r3'],
                ['r4', 'r5', 'r6', 'r7'],
                ['r8', 'r9', 'r10', 'r11'],
                ['r12', 'sp', 'lr', 'pc'],
            ];
            for (const row of rows) {
                result += '  ' + row.map(r => `${r.padEnd(4)}= ${this.normalizeRegToHex(regs[r] || '<?>').padEnd(14)}`).join('') + '\n';
            }
            result += `  xpsr = ${regs['xpsr'] || '<?>'}\n`;
            result += `  msp  = ${this.normalizeRegToHex(regs['msp'] || '<?>')}\n`;
            result += `  psp  = ${this.normalizeRegToHex(regs['psp'] || '<?>')}\n`;
            result += `  control   = ${regs['control'] || '<?>'}\n`;
            result += `  faultmask = ${this.normalizeRegToHex(regs['faultmask'] || '<?>')}\n`;
            result += `  basepri   = ${this.normalizeRegToHex(regs['basepri'] || '<?>')}\n`;
            result += `  primask   = ${this.normalizeRegToHex(regs['primask'] || '<?>')}\n`;

            return result;
        });
    }

    /**
     * Read peripheral register(s) via Peripheral Inspector or memory fallback
     */
    public async handleReadPeripheralRegister(args: { peripheral: string; register?: string; timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('read_peripheral_register', args.timeoutMs, async () => {
            await this.ensureStoppedSession('read peripheral register');
            return await this.executor.readPeripheralRegister(args.peripheral, args.register, args.timeoutMs);
        });
    }

    /**
     * Read and decode Cortex-M fault registers
     */
    public async handleGetFaultInfo(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_fault_info', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('read fault info');
            return await this.executor.getFaultInfo(args?.timeoutMs);
        });
    }

    /**
     * Get debug target / session information.
     * Does NOT require the target to be stopped — only reads the launch
     * configuration object that VS Code already holds in memory.
     */
    public async handleGetDeviceInfo(): Promise<string> {
        try {
            if (!this.executor.hasDebugSession()) {
                throw new Error('No active debug session. Start debugging first.');
            }
            return await this.executor.getDeviceInfo();
        } catch (error) {
            throw new Error(`Error getting device info: ${error}`);
        }
    }

    /**
     * Run a low-cost connectivity probe against the target. Safe to call even
     * when other tool invocations have started failing — it never issues a
     * long-running DAP request and uses a short internal timeout.
     */
    public async handleCheckTargetConnection(): Promise<string> {
        try {
            return await this.executor.checkTargetConnection();
        } catch (error) {
            if (error instanceof HardwareTimeoutError) {
                return `check_target_connection: ${error.message}`;
            }
            throw new Error(`Error checking target connection: ${error}`);
        }
    }

    /**
     * Report the structured debug-session status. Never throws — designed to
     * be the agent's first port of call when it is unsure whether a session
     * is alive, running, stopped, or wedged.
     */
    /**
     * Return the full call stack of the active (or specified) thread.
     */
    public async handleGetCallStack(args: { threadId?: number; levels?: number; timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_call_stack', args.timeoutMs, async () => {
            await this.ensureStoppedSession('get call stack');
            const frames = await this.executor.getCallStack(args.threadId, args.levels ?? 50, args.timeoutMs);
            if (frames.length === 0) {
                return 'No stack frames available.';
            }
            const lines: string[] = [];
            lines.push(`Call stack (${frames.length} frame${frames.length === 1 ? '' : 's'}):`);
            frames.forEach((f, i) => {
                const loc = f.source ? `${f.source}:${f.line ?? '?'}` : `<no source>:${f.line ?? '?'}`;
                const fid = f.frameId !== undefined ? ` [frameId=${f.frameId}]` : '';
                lines.push(`  #${i.toString().padStart(2, ' ')}  ${f.name}  @ ${loc}${fid}`);
            });
            lines.push('');
            lines.push('Tip: use get_frame_variables with a frameId to inspect variables of a specific frame.');
            return lines.join('\n');
        });
    }

    /**
     * List DAP threads. With an RTOS-aware GDB server (pyOCD --rtos, J-Link
     * RTOS plugin), each FreeRTOS/RTX/etc. task is enumerated as a thread.
     */
    public async handleGetThreads(args?: { timeoutMs?: number }): Promise<string> {
        return withHandlerTimeout('get_threads', args?.timeoutMs, async () => {
            await this.ensureStoppedSession('get threads');
            const threads = await this.executor.getThreads(args?.timeoutMs);
            if (threads.length === 0) {
                return 'No threads reported by the debug adapter.';
            }
            const lines: string[] = [];
            lines.push(`Threads / RTOS tasks (${threads.length}):`);
            for (const t of threads) {
                const top = t.topFrame
                    ? `  → ${t.topFrame.name} @ ${t.topFrame.source ?? '<no source>'}:${t.topFrame.line ?? '?'}`
                    : '';
                lines.push(`  [${t.id}] ${t.name}${top}`);
            }
            lines.push('');
            lines.push('Tip: pass a threadId to get_call_stack to inspect a specific task.');
            return lines.join('\n');
        });
    }

    /**
     * Get variables for an explicit frame id (e.g. a caller frame from get_call_stack).
     */
    public async handleGetFrameVariables(args: { frameId: number; scope?: 'local' | 'global' | 'all'; timeoutMs?: number }): Promise<string> {
        const { frameId, scope = 'all', timeoutMs } = args;
        return withHandlerTimeout('get_frame_variables', timeoutMs, async () => {
            await this.ensureStoppedSession('get frame variables');
            const variablesData = await this.executor.getVariablesForFrame(frameId, scope, timeoutMs);
            if (!variablesData.scopes || variablesData.scopes.length === 0) {
                return `No variable scopes available for frameId=${frameId}.`;
            }
            let out = `Variables for frameId=${frameId}:\n==========\n\n`;
            for (const scopeItem of variablesData.scopes) {
                out += `${scopeItem.name}:\n`;
                if (scopeItem.error) {
                    out += `  Error retrieving variables: ${scopeItem.error}\n`;
                } else if (scopeItem.variables && scopeItem.variables.length > 0) {
                    for (const v of scopeItem.variables) {
                        out += `  ${v.name}: ${v.value}${v.type ? ` (${v.type})` : ''}\n`;
                    }
                } else {
                    out += '  No variables in this scope\n';
                }
                out += '\n';
            }
            return out;
        });
    }

    /**
     * Drive the CMSIS Solution extension's flash / debug commands — the same
     * actions the buttons in the CMSIS Solution panel invoke. They operate on
     * the currently active csolution context (no arguments).
     */
    public async handleCmsisCommand(args: { action: CmsisAction; timeoutMs?: number }): Promise<string> {
        // Pre-check: refuse to flash+attach on top of an already-active session.
        if ((args.action === 'load_and_debug' || args.action === 'attach') && this.executor.hasDebugSession()) {
            const status = await this.executor.getSessionStatus();
            return `A debug session is already active (name='${status.sessionName ?? '?'}', state=${status.state}). ` +
                `Refusing to ${args.action}. Use stop_debugging or restart_debugging first, or proceed with inspection.`;
        }

        const map: Record<CmsisAction, string> = {
            build:           'cmsis-csolution.build',
            load:            'cmsis-csolution.cmsisLoad',
            erase:           'cmsis-csolution.cmsisErase',
            load_and_run:    'cmsis-csolution.cmsisLoadAndRun',
            load_and_debug:  'cmsis-csolution.cmsisLoadAndDebug',
            attach:          'cmsis-csolution.cmsisAttachDebugger',
            detach:          'cmsis-csolution.cmsisDetachDebugger',
            stop_run:        'cmsis-csolution.cmsisStopRun',
        };
        const cmd = map[args.action];
        if (!cmd) {
            throw new Error(`Unknown CMSIS action: ${args.action}`);
        }

        try {
            await vscode.commands.executeCommand(cmd);
        } catch (error) {
            throw new Error(`CMSIS command '${cmd}' failed: ${error}. ` +
                `Ensure the CMSIS Solution extension is installed and a solution context is active.`);
        }

        // For actions that should leave a debug session running, wait until
        // it is actually usable so the agent does not race on the next call.
        if (args.action === 'load_and_debug' || args.action === 'attach') {
            const sessionActive = await this.waitForActiveDebugSession(args.timeoutMs);
            if (!sessionActive) {
                const waited = args.timeoutMs ? `${Math.round(Math.min(args.timeoutMs, 60_000) / 1000)}s` : `${this.timeoutInSeconds}s`;
                return `CMSIS '${args.action}' issued via '${cmd}', but no debug session became ready within ${waited}. ` +
                    `The flash/connect step may still be in progress — check the CMSIS output channel.`;
            }
            const state = await this.executor.getCurrentDebugState(this.numNextLines);
            return `CMSIS '${args.action}' completed. Debug session state: ${state.toString()}`;
        }

        return `CMSIS '${args.action}' command '${cmd}' executed. Check the CMSIS output channel for build/flash progress.`;
    }

    public async handleGetSessionStatus(): Promise<string> {
        const status = await this.executor.getSessionStatus();
        const lines: string[] = [];
        lines.push(`State: ${status.state}`);
        if (status.sessionName) { lines.push(`Session: ${status.sessionName}`); }
        if (status.sessionType) { lines.push(`Type: ${status.sessionType}`); }
        if (status.configurationName) { lines.push(`Configuration: ${status.configurationName}`); }
        lines.push(`DAP responsive: ${status.dapResponsive}${status.dapProbeMs !== null ? ` (probe ${status.dapProbeMs}ms)` : ''}`);
        if (status.detail) { lines.push(`Detail: ${status.detail}`); }

        // Add a hint so the agent knows what it can do next.
        switch (status.state) {
            case 'no-session':
                lines.push('Hint: call start_debugging to attach.');
                break;
            case 'initializing':
                lines.push('Hint: the adapter is still starting — wait a moment and retry.');
                break;
            case 'running':
                lines.push('Hint: target is running. Add a breakpoint, then call continue_execution, or call stop_debugging.');
                break;
            case 'stopped':
                lines.push('Hint: full inspection (variables, memory, registers) is available.');
                break;
            case 'unresponsive':
                lines.push('Hint: probe/GDB server is hung. Try restart_debugging, stop_debugging, or check the physical connection.');
                break;
        }
        return lines.join('\n');
    }
}
