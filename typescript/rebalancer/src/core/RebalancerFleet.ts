import { type Logger } from 'pino';

import { type IRegistry } from '@hyperlane-xyz/registry';
import { type MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, sleep } from '@hyperlane-xyz/utils';

import { type RebalancerConfig } from '../config/RebalancerConfig.js';
import { Mutex } from '../utils/mutex.js';

import {
  RebalancerService,
  type RebalancerServiceConfig,
} from './RebalancerService.js';

const HEALTHY_RUN_MS = 30 * 60_000;
const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

type ManagedService = Pick<RebalancerService, 'start' | 'gracefulShutdown'>;

export interface FleetMember {
  rebalancerConfig: RebalancerConfig;
}

export interface RebalancerFleetOptions {
  checkFrequency: number;
  monitorOnly: boolean;
  withMetrics: boolean;
  coingeckoApiKey?: string;
  version?: string;
  /** Delay between member starts. Default: floor(checkFrequency / memberCount). */
  staggerMs?: number;
}

interface MemberState {
  member: FleetMember;
  serviceConfig: RebalancerServiceConfig;
  service: ManagedService;
  firstAttemptFailed: boolean;
}

export class RebalancerFleet {
  private readonly executionLock = new Mutex();
  private readonly memberStates: MemberState[];
  private readonly staggerMs: number;
  private readonly stopped: Promise<void>;
  private resolveStopped: () => void = () => undefined;
  private started = false;
  private shuttingDown = false;
  private signalHandlersRegistered = false;
  private hasEverRunHealthy = false;
  private fatalStartupTriggered = false;
  private stopOperation?: Promise<void>;

  constructor(
    private readonly multiProvider: MultiProvider,
    private readonly registry: IRegistry,
    members: FleetMember[],
    options: RebalancerFleetOptions,
    private readonly logger: Logger,
  ) {
    assert(members.length > 0, 'Rebalancer fleet requires at least one member');

    const warpRouteIds = members.map(
      ({ rebalancerConfig }) => rebalancerConfig.warpRouteId,
    );
    assert(
      new Set(warpRouteIds).size === warpRouteIds.length,
      'Rebalancer fleet warpRouteIds must be unique',
    );

    this.staggerMs =
      options.staggerMs ?? Math.floor(options.checkFrequency / members.length);
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
    this.memberStates = members.map((member) => {
      const { warpRouteId } = member.rebalancerConfig;
      const serviceConfig: RebalancerServiceConfig = {
        mode: 'daemon',
        checkFrequency: options.checkFrequency,
        monitorOnly: options.monitorOnly,
        withMetrics: options.withMetrics,
        coingeckoApiKey: options.coingeckoApiKey,
        version: options.version,
        logger: logger.child({ warpRouteId }),
        ownsProcess: false,
        executionLock: this.executionLock,
      };
      return {
        member,
        serviceConfig,
        service: this.createService(member, serviceConfig),
        firstAttemptFailed: false,
      };
    });
  }

  protected createService(
    member: FleetMember,
    serviceConfig: RebalancerServiceConfig,
  ): ManagedService {
    return new RebalancerService(
      this.multiProvider,
      undefined,
      this.registry,
      member.rebalancerConfig,
      serviceConfig,
    );
  }

  async start(): Promise<void> {
    if (!this.started && !this.shuttingDown) {
      this.started = true;
      this.registerSignalHandlers();
      for (const [index, state] of this.memberStates.entries()) {
        void this.superviseMember(state, index * this.staggerMs);
      }
    }

    await this.stopped;
  }

  async stop(): Promise<void> {
    this.stopOperation ??= this.stopServices();
    await this.stopOperation;
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;

    process.on('SIGINT', this.handleSignal);
    process.on('SIGTERM', this.handleSignal);
    this.signalHandlersRegistered = true;
  }

  private unregisterSignalHandlers(): void {
    if (!this.signalHandlersRegistered) return;

    process.off('SIGINT', this.handleSignal);
    process.off('SIGTERM', this.handleSignal);
    this.signalHandlersRegistered = false;
  }

  private readonly handleSignal = async (): Promise<void> => {
    await this.stop();
    process.exit(0);
  };

  private async superviseMember(
    state: MemberState,
    initialDelayMs: number,
  ): Promise<void> {
    if (!(await this.waitForRestart(initialDelayMs))) return;

    let consecutiveFailures = 0;
    let firstAttempt = true;

    while (!this.shuttingDown) {
      const startedAt = Date.now();
      let error: unknown;

      try {
        await state.service.start();
      } catch (startError) {
        error = startError;
      }

      if (this.shuttingDown) return;

      const runDurationMs = Date.now() - startedAt;
      if (runDurationMs >= HEALTHY_RUN_MS) {
        consecutiveFailures = 0;
        this.hasEverRunHealthy = true;
      }

      if (firstAttempt) {
        firstAttempt = false;
        state.firstAttemptFailed = true;
        if (this.shouldExitAfterFatalStartup()) return;
      }

      const delayMs = Math.min(
        INITIAL_BACKOFF_MS * 2 ** consecutiveFailures,
        MAX_BACKOFF_MS,
      );
      this.logger.error(
        {
          warpRouteId: state.member.rebalancerConfig.warpRouteId,
          consecutiveFailures,
          delayMs,
          error,
        },
        error
          ? 'Rebalancer fleet member failed; scheduling restart'
          : 'Rebalancer fleet member stopped unexpectedly; scheduling restart',
      );
      consecutiveFailures += 1;

      if (!(await this.waitForRestart(delayMs))) return;

      state.service = this.createService(state.member, state.serviceConfig);
    }
  }

  private shouldExitAfterFatalStartup(): boolean {
    if (
      this.hasEverRunHealthy ||
      this.fatalStartupTriggered ||
      !this.memberStates.every(({ firstAttemptFailed }) => firstAttemptFailed)
    ) {
      return false;
    }

    this.fatalStartupTriggered = true;
    this.shuttingDown = true;
    this.logger.fatal(
      {
        warpRouteIds: this.memberStates.map(
          ({ member }) => member.rebalancerConfig.warpRouteId,
        ),
      },
      'Every rebalancer fleet member failed during initial startup',
    );
    process.exit(1);
  }

  private async waitForRestart(delayMs: number): Promise<boolean> {
    if (this.shuttingDown) return false;
    if (delayMs === 0) return true;

    await Promise.race([sleep(delayMs), this.stopped]);
    return !this.shuttingDown;
  }

  private async stopServices(): Promise<void> {
    this.shuttingDown = true;
    this.unregisterSignalHandlers();

    const results = await Promise.allSettled(
      this.memberStates.map(({ service }) => service.gracefulShutdown()),
    );
    for (const [index, result] of results.entries()) {
      const state = this.memberStates[index];
      if (!state) continue;

      const warpRouteId = state.member.rebalancerConfig.warpRouteId;
      if (result.status === 'fulfilled') {
        this.logger.info(
          { warpRouteId },
          'Rebalancer fleet member shutdown complete',
        );
      } else {
        this.logger.error(
          { warpRouteId, error: result.reason },
          'Rebalancer fleet member shutdown failed',
        );
      }
    }

    this.resolveStopped();
  }
}
