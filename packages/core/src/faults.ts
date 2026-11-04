/**
 * Gate 0 fault injection.
 *
 * This simulates a process being killed at a known point — it does NOT prove
 * power-loss durability. Real power loss additionally involves OS cache flush
 * behaviour, which is documented as an explicit residual risk (ADR-0003).
 */

export type FaultPoint = 'prepared' | 'files_applied' | 'portable_committed';

export function faultInjectionEnabled(): boolean {
  return typeof process.env.NS_FAULT_INJECT === 'string' && process.env.NS_FAULT_INJECT.length > 0;
}

export function faultInject(point: FaultPoint): void {
  const configured = process.env.NS_FAULT_INJECT;
  if (configured !== point) return;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NS_FAULT_INJECT must never be set in production');
  }
  // Hard kill: no finally blocks, no buffered writes flushed by us.
  process.kill(process.pid, 'SIGKILL');
  // Fallback for platforms where SIGKILL is not delivered synchronously.
  process.exit(137);
}
