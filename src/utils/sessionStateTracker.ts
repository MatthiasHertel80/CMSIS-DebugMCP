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

/**
 * Live debug sessions seen by the adapter tracker, most-recently-started last.
 * `vscode.debug.activeDebugSession` only reflects the session the VS Code UI
 * currently has focused — it is `undefined` whenever focus is elsewhere, which
 * is common with `gdbtarget` multi-core launches. This list lets us answer
 * "is there a debug session at all?" independently of UI focus.
 *
 * Note: a debug session in a *different* VS Code window runs in a different
 * extension host and is genuinely invisible here — that case cannot be fixed.
 */
const liveSessions: vscode.DebugSession[] = [];

function getOrInit(session: vscode.DebugSession): SessionExecState {
    let state = sessionStates.get(session);
    if (!state) {
        state = { lastEvent: null, stoppedReason: null, lastEventAt: 0 };
        sessionStates.set(session, state);
    }
    return state;
}

function addLiveSession(session: vscode.DebugSession): void {
    if (!liveSessions.includes(session)) {
        liveSessions.push(session);
    }
}

function removeLiveSession(session: vscode.DebugSession): void {
    const idx = liveSessions.indexOf(session);
    if (idx !== -1) {
        liveSessions.splice(idx, 1);
    }
}

/**
 * The most-recently-started live debug session, or `undefined` if none.
 * Use as a fallback when `vscode.debug.activeDebugSession` is `undefined`
 * but a session is in fact running in this window.
 */
export function getMostRecentLiveSession(): vscode.DebugSession | undefined {
    return liveSessions.length > 0 ? liveSessions[liveSessions.length - 1] : undefined;
}

/** Number of live debug sessions this extension host has seen via the adapter tracker. */
export function getLiveSessionCount(): number {
    return liveSessions.length;
}

/** Names of the live debug sessions, for diagnostics. */
export function getLiveSessionNames(): string[] {
    return liveSessions.map(s => s.name);
}

/**
 * Resolve "the debug session the agent should operate on": VS Code's focused
 * session if there is one, otherwise the most-recently-started tracked
 * session. This is the single source of truth the executor should use
 * instead of reading `vscode.debug.activeDebugSession` directly.
 */
export function resolveActiveSession(): vscode.DebugSession | undefined {
    return vscode.debug.activeDebugSession ?? getMostRecentLiveSession();
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
            addLiveSession(session);
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
                        removeLiveSession(session);
                    }
                },
                onWillStopSession(): void {
                    sessionStates.delete(session);
                    removeLiveSession(session);
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

    // Belt-and-braces: also drop sessions on the VS Code termination event,
    // in case the adapter tracker's onWillStopSession did not fire.
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            sessionStates.delete(session);
            removeLiveSession(session);
        }),
    );

    logger.info('Session state tracker registered (DAP stopped/continued events + live-session list)');
}
