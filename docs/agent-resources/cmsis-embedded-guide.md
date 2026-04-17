# CMSIS Embedded Debugging Guide

## Debugging Workflow for Cortex-M Targets

### Starting a Debug Session
- Use `start_debugging` with `configurationName` matching the launch.json entry
- Common config names: "CMSIS Debugger: pyOCD", "CMSIS Debugger: J-LINK"
- Wait for the session to stop at `main` (the default initCommand sets `break main`)

### When the Target Hits a HardFault
1. Call `get_fault_info` to read and decode CFSR/HFSR/BFAR/MMFAR
2. Check the call stack with `get_variables_values` to see where the fault occurred
3. Common causes:
   - DACCVIOL/IACCVIOL: Null pointer dereference or MPU violation
   - PRECISERR with BFARVALID: Read/write to invalid peripheral address (check BFAR)
   - UNDEFINSTR: Corrupted function pointer or stack overflow overwrote code
   - NOCP: FPU instruction but FPU not enabled (check CPACR at 0xE000ED88)
   - DIVBYZERO: Only faults if DIV_0_TRP is set in CCR (0xE000ED14)

### Inspecting Peripheral State
- Use `read_peripheral_register` with the peripheral name (e.g., "GPIOA")
- Peripheral names come from the SVD file; common ones: GPIOx, UART, SPI, I2C, TIM, RCC, NVIC
- To check if a clock is enabled: read RCC registers (RCC.AHBxENR, RCC.APBxENR)
- To check interrupt configuration: read NVIC registers (NVIC.ISER, NVIC.ISPR, NVIC.IPR)

### Memory Layout (Cortex-M typical)
- 0x00000000 - 0x1FFFFFFF: Code (Flash)
- 0x20000000 - 0x3FFFFFFF: SRAM
- 0x40000000 - 0x5FFFFFFF: Peripheral registers
- 0xE0000000 - 0xE00FFFFF: System (SCS, NVIC, SysTick, MPU, FPU)

### Key System Registers
- VTOR (0xE000ED08): Vector Table Offset Register
- AIRCR (0xE000ED0C): Application Interrupt and Reset Control
- SCR (0xE000ED10): System Control Register
- CCR (0xE000ED14): Configuration and Control Register
- CPACR (0xE000ED88): Coprocessor Access Control (FPU enable)
- ICSR (0xE000ED04): Interrupt Control and State Register
- SHCSR (0xE000ED24): System Handler Control and State Register

### Stack Overflow Detection
1. Read MSP and PSP with `read_core_registers`
2. Compare against known stack boundaries (from linker script / .map file)
3. If SP is outside the valid stack region, stack overflow occurred
4. Check if stack canary value at bottom of stack is corrupted

### Debugging Tips
- After a fault, the stacked PC (at SP+24 for basic frame, SP+104 for FP frame) shows the faulting instruction
- Use `evaluate_expression` with GDB commands: e.g., `info threads`, `info registers`
- For RTOS-aware debugging: check thread stacks individually via the CALL STACK view
- `read_memory` at the stack pointer shows the exception frame: R0,R1,R2,R3,R12,LR,PC,xPSR

### Available Embedded Tools
| Tool | Description |
|---|---|
| `read_memory` | Read a range of bytes from target memory (hex/ASCII dump) |
| `read_core_registers` | Read all Cortex-M core registers (R0-R15, xPSR, MSP, PSP, etc.) |
| `read_peripheral_register` | Read peripheral registers via SVD data or memory fallback |
| `get_fault_info` | Decode Cortex-M fault status registers (CFSR, HFSR, BFAR, MMFAR) |
| `get_device_info` | Show debug session info (target, GDB server, program, etc.) |
