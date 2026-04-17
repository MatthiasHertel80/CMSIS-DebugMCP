# Embedded Debugging Troubleshooting

## Common Issues

### Debug Session Won't Start
- Verify the GDB server (pyOCD or J-Link) is installed and on PATH
- Check that the debug probe is connected and detected (`pyocd list` or `JLinkExe`)
- Ensure the correct device is selected in the launch configuration
- Check if another debug session is already using the probe

### Target Doesn't Stop at main
- Verify `"break main"` is in `initCommands` in launch.json
- Some targets require a reset before the breakpoint is hit
- Check if the program was loaded correctly: `initCommands` should include `"load"`

### HardFault on Startup
- Call `get_fault_info` to decode the fault registers
- Common cause: missing or incorrect vector table (check VTOR at 0xE000ED08)
- Check if the stack pointer is initialized correctly (first word of vector table)
- Verify the reset handler address (second word of vector table)

### Variables Show "optimized out"
- The compiler optimized the variable away. Rebuild with `-O0` (no optimization)
- For CMSIS projects, set optimization in the `.cproject` or `csolution.yml`

### Memory Read Returns All 0xFF or 0x00
- The memory region may not be mapped or powered
- Check if the peripheral clock is enabled (read RCC enable registers)
- Verify the address is correct for your specific device variant

### Stepping Doesn't Work / Steps to Wrong Line
- This can happen with optimized code — rebuild with `-O0 -g3`
- For inline functions, the debugger may jump between files unexpectedly
- Try `step_into` instead of `step_over` to see what's actually executing

### GDB Expressions for Embedded
- Read a memory-mapped register: `*(volatile unsigned int*)0x40020014`
- Read program counter: `$pc`
- Read stack pointer: `$sp`
- Read link register: `$lr`
- Disassemble around PC: `-exec disassemble $pc-16,$pc+16`
- Show exception frame: `-exec x/8xw $sp` (R0,R1,R2,R3,R12,LR,PC,xPSR)

### Multi-Core Debugging (Alif AppKit)
- The Alif AppKit has dual Cortex-M55 cores (HP + HE)
- Each core gets a separate debug session
- Use VS Code's debug session picker to switch between cores
- The active tools operate on whichever session is currently selected

## Fault Analysis Quick Reference

| Fault Bit | Register | Meaning |
|---|---|---|
| FORCED | HFSR | Fault escalated to HardFault — check CFSR |
| DACCVIOL | MMFSR | Data access violation (null ptr, MPU) |
| IACCVIOL | MMFSR | Instruction access violation |
| PRECISERR | BFSR | Precise bus error — check BFAR for address |
| IMPRECISERR | BFSR | Imprecise bus error (buffered write) |
| UNDEFINSTR | UFSR | Undefined instruction |
| INVSTATE | UFSR | Invalid EPSR.T bit (tried ARM mode) |
| NOCP | UFSR | Coprocessor not enabled (FPU?) |
| DIVBYZERO | UFSR | Division by zero |
| UNALIGNED | UFSR | Unaligned access |
