# CMSIS-DebugMCP improvement notes & roadmap

Field notes collected from real hardware sessions (ModelNova, Alif AppKit-E8 /
Ensemble E8) whenever the agent had to **leave the MCP tool surface** and drive
`pyocd` / `JLinkGDBServerCL` / shell tools directly. Each item records what was
bypassed, why, and the tool/feature that would have kept the workflow inside
DebugMCP. This is a living document — keep it in sync as items ship.

## Status

**Closed**

| # | Item | Shipped in |
|---|------|-----------|
| 1 (build half) | Synchronous build result — `cmsis_action build` now waits for the cbuild task and returns the real exit code (✅/❌), never "check the output channel". | 1.2.1 |
| — | Attach zombie-detection — `cmsis_action attach` distinguishes a real connection (≥1 thread) from a phantom `gdbtarget` session with no target behind the port. | 1.1.7–1.1.9 |

**Top remaining (priority order)**

1. **Synchronous flash result for `load`** — apply the same task-exit-code
   treatment as `build` to `load` / `load_and_run` (item 1 below). `load`
   already waits for the task as of 1.2.1, but confirm it reports bytes
   programmed / a real flash error, not just an exit code.
2. **Reset with verification** — silent non-resets and SWD wedges from
   unsequenced resets bit us repeatedly (item 3).
3. **`wait_for_stop`** — block until the next stop instead of sleeping blind
   (item 6).
4. **Launch-failure diagnostics passthrough** — surface the underlying DAP/task
   error instead of one opaque line (item 7).
5. **pyocd-gdbserver as a documented fallback path** — when the VS Code launch
   pipeline can't spawn a server, bring one up / document the manual path
   (item 2).

---

## Field notes (verbatim)

### 1. Flashing (bypassed with `pyocd load --cbuild-run <file>`)
- `cmsis_action load` is fire-and-forget ("check the CMSIS output channel")
  — an agent cannot read that channel, so success/failure is unknowable.
  *(Partly addressed in 1.2.1: `load` now waits for the cbuild/flash task and
  returns its exit code. Still want bytes-programmed / structured flash error.)*
- `start_debugging` with a launch config that has a `CMSIS Load` preLaunchTask
  failed opaquely; the attach config cannot flash at all.
- Suggestion: develop a status channel for flash programming

### 2. GDB server lifecycle (bypassed with manual `JLinkGDBServerCL ...`)
- When the VS Code launch pipeline fails to spawn the server (renderer error
  "Converting circular structure to JSON"), there is no MCP way to bring one
  up for the attach config.
- Suggestion: `start_gdb_server` / `stop_gdb_server` tools that read server
  command + parameters from launch.json or cbuild-run, plus a liveness probe
  (port listening, first DAP ping). Document `pyocd gdbserver` as the fallback.

### 3. Target reset (bypassed with `pyocd reset -m hw`)
- `restart_debugging` on an attach config silently stopped resetting the
  target (RTOS tick and counters survived "restarts"); nothing in the result
  said so.
- A wedged USB device controller required a hardware (nSRST) reset — no MCP
  tool can request a reset method.
- Suggestions: (a) a `reset` tool with method selection (core / hw / por,
  probe-dependent); (b) `restart_debugging` should verify the reset took
  effect (e.g. kernel tick or DWT cycle counter went backwards) and report
  "restarted but target did NOT reset" honestly.

### 4. Cycle-accurate timing (bypassed with `evaluate_expression` on 0xE0001004)
- Stage timing was measured by hand-reading DWT_CYCCNT at breakpoints.
- Suggestion: a `read_cycle_counter` / `profile_between_breakpoints` helper
  that knows the DWT (enable TRCENA if needed, warn about the 32-bit wrap at
  ~10.7 s @ 400 MHz, and that CYCCNT halts during core halt AND during WFE
  sleep - both bit us).

### 5. RTOS time / uptime (bypassed with inferior call `osKernelGetTickCount()`)
- Used as a run-time-only timebase for fps measurements.
- Suggestion: an RTOS-aware `get_kernel_time` (RTX/FreeRTOS detection), or
  document the inferior-call pattern; inferior calls from an idle-thread stop
  worked but feel fragile.

### 6. Wait-for-stop (bypassed with shell sleep + pause/status polling)
- After `continue_execution` an agent has no way to block until the next stop;
  it either sleeps blind or pauses too early (we missed a 15 s playback window
  this way once).
- Suggestion: `wait_for_stop(timeoutMs)` — returns on breakpoint/fault/stop
  with the stop reason, or timeout.

### 7. Launch failure diagnostics (bypassed by grepping VS Code logs)
- `start_debugging` failures return one opaque line; the real cause (task
  error, DAP error, config resolution) is only in the extension host /
  renderer logs.
- Suggestion: surface the underlying DAP/task error text in the tool error;
  optionally a `get_last_session_diagnostics` tool.

### 8. Host-side USB enumeration checks (bypassed with `ioreg`/`system_profiler`)
- Bring-up debugging needed "is the device enumerated on the host?" several
  times (SDSIO client, VID/PID checks). Arguably out of scope, but a tiny
  `list_usb_devices` host utility would complete the embedded bring-up story.

### 9. Post-mortem with broken debug access
- After a hard fault the fault-register and stacked-frame reads failed
  ("all GDB strategies exhausted") until probe reconnect. A `reconnect_probe`
  or automatic retry-with-reconnect inside read_memory would save the manual
  server bounce.
