// Copyright (c) Microsoft Corporation.

import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Per-session record of the most recent execution-state events seen on the
 * Debug Adapter Protocol channel. We track this because neither
 * `vscode.debug.activeDebugSession` nor `vscode.debug.activeStackItem` is a
 * reliable "is the target stopped?" signal on embedded targets:
 *
 *   - `activeStackItem` is `undefined` whenever the CPU is running.
 *   - It is also `undefined` for a brief window after a stop event, before
 *     VS Code surfaces the new stack frame.
 *   - It can remain set briefly after a `continued` event.
 *
 * The DAP `stopped` / `continued` events are the ground truth, so we record
 * them here and expose a synchronous query.
 */
interface SessionExecState {
    /** Last execution-state transition observed on this session. */
    lastEvent: 'stopped' | 'continued' | null;
    /** Reason from the DAP `stopped` event (e.g. "breakpoint", "step", "exception"). */
    stoppedReason: string | null;
    /** Wall-clock time of the last transition. */
    lastEventAt: number;
}

const sessionStates = new WeakMap<vscode.DebugSession, SessionExecState>();

function getOrInit(session: vscode.DebugSession): SessionExecState {
    let state = sessionStates.get(session);
    if (!state) {
        state = { lastEvent: null, stoppedReason: null, lastEventAt: 0 };
        sessionStates.set(session, state);
    }
    return state;
}

/**
 * Authoritative answer to "is this session currently stopped at a frame the
 * agent can inspect?". Combines DAP event history with VS Code's
 * `activeStackItem` to ride out the brief races on either side of a stop.
 */
export function isSessionStopped(session: vscode.DebugSession): boolean {
    const state = sessionStates.get(session);

    // Authoritative if we have seen DAP events for this session.
    if (state?.lastEvent === 'stopped') {
        return true;
    }
    if (state?.lastEvent === 'continued') {
        return false;
    }

    // No DAP events yet (e.g. attach without an initial stop) — fall back to
    // VS Code's view. This is the same heuristic the rest of the executor
    // used historically.
    const item = vscode.debug.activeStackItem;
    return item !== undefined && 'frameId' in item && item.session === session;
}

/**
 * Reason the target is currently stopped, or null if running / unknown.
 * Useful for surfacing "stopped at breakpoint" vs "stopped at exception".
 */
export function getStoppedReason(session: vscode.DebugSession): string | null {
    const state = sessionStates.get(session);
    return state?.lastEvent === 'stopped' ? state.stoppedReason : null;
}

/**
 * Register a global DebugAdapterTracker that records `stopped` and
 * `continued` events for every debug session VS Code starts. Call once
 * during extension activation.
 */
export function registerSessionStateTracker(context: vscode.ExtensionContext): void {
    const factory: vscode.DebugAdapterTrackerFactory = {
        createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
            return {
                onDidSendMessage(message: any): void {
                    if (message?.type !== 'event') { return; }
                    const state = getOrInit(session);
                    if (message.event === 'stopped') {
                        state.lastEvent = 'stopped';
                        state.stoppedReason = message.body?.reason ?? null;
                        state.lastEventAt = Date.now();
                        logger.debug(`[session-tracker] stopped (${state.stoppedReason}) on ${session.name}`);
                    } else if (message.event === 'continued') {
                        state.lastEvent = 'continued';
                        state.stoppedReason = null;
                        state.lastEventAt = Date.now();
                        logger.debug(`[session-tracker] continued on ${session.name}`);
                    } else if (message.event === 'terminated' || message.event === 'exited') {
                        sessionStates.delete(session);
                    }
                },
                onWillStopSession(): void {
                    sessionStates.delete(session);
                },
                onError(error: Error): void {
                    logger.debug(`[session-tracker] adapter error on ${session.name}`, error);
                },
            };
        },
    };

    // Register for every debug type. VS Code lets us pass '*' to match all.
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory('*', factory),
    );
    logger.info('Session state tracker registered (DAP stopped/continued events)');
}
