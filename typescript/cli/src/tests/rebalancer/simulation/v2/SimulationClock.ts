/**
 * SimulationClock
 *
 * Synchronizes JavaScript time (via Sinon fake timers) with EVM time.
 * This allows the simulation to control time for both the rebalancer
 * (which uses Date.now() and setTimeout) and the blockchain (block.timestamp).
 */
import type { JsonRpcProvider } from '@ethersproject/providers';
import sinon from 'sinon';

export interface SimulationClockConfig {
  /** Starting timestamp (ms since epoch). Defaults to Date.now() */
  startTime?: number;
}

export class SimulationClock {
  private sinonClock: sinon.SinonFakeTimers;
  private provider: JsonRpcProvider;
  private currentTimeMs: number;
  private startTimeMs: number;

  constructor(provider: JsonRpcProvider, config: SimulationClockConfig = {}) {
    this.provider = provider;
    this.startTimeMs = config.startTime ?? Date.now();
    this.currentTimeMs = this.startTimeMs;

    // Install fake timers
    // Only fake Date - don't fake setTimeout/setInterval as they interfere with
    // network operations (HTTP requests use timers internally)
    this.sinonClock = sinon.useFakeTimers({
      now: this.startTimeMs,
      shouldAdvanceTime: false, // We control time explicitly
      toFake: ['Date'], // Only fake Date, not timers
    });
  }

  /**
   * Advance both JS time and EVM time by the specified duration.
   *
   * @param ms Milliseconds to advance
   */
  async advanceTime(ms: number): Promise<void> {
    if (ms <= 0) return;

    // Advance JS time (this triggers any pending setTimeout/setInterval)
    this.sinonClock.tick(ms);
    this.currentTimeMs += ms;

    // Advance EVM time
    const seconds = Math.floor(ms / 1000);
    if (seconds > 0) {
      await this.provider.send('evm_increaseTime', [seconds]);
      await this.provider.send('evm_mine', []);
    }
  }

  /**
   * Advance time to a specific simulation timestamp.
   *
   * @param targetTimeMs Target time in ms since epoch
   */
  async advanceTo(targetTimeMs: number): Promise<void> {
    const delta = targetTimeMs - this.currentTimeMs;
    if (delta > 0) {
      await this.advanceTime(delta);
    }
  }

  /**
   * Get current simulation time (ms since epoch).
   */
  getCurrentTime(): number {
    return this.currentTimeMs;
  }

  /**
   * Get elapsed simulation time since start (ms).
   */
  getElapsedTime(): number {
    return this.currentTimeMs - this.startTimeMs;
  }

  /**
   * Get start time (ms since epoch).
   */
  getStartTime(): number {
    return this.startTimeMs;
  }

  /**
   * Mine a single block without advancing time.
   * Useful for processing pending transactions.
   */
  async mineBlock(): Promise<void> {
    await this.provider.send('evm_mine', []);
  }

  /**
   * Restore real time. Must be called after simulation completes.
   */
  restore(): void {
    this.sinonClock.restore();
  }

  /**
   * Run any pending timers without advancing time.
   * Useful for flushing queued callbacks.
   */
  runPendingTimers(): void {
    this.sinonClock.runAll();
  }
}
