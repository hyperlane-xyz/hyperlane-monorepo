/**
 * Phase-based test runner for rebalancer crash resilience testing.
 *
 * This module provides abstractions for testing rebalancer behavior
 * at different phases of operation, enabling crash resilience testing.
 *
 * @example
 * ```typescript
 * const runner = createPhaseRunner(setup);
 *
 * // Test crash after imbalance detection but before rebalance
 * await runner.runWithPhases({
 *   phases: [Phase.PRE_IMBALANCE, Phase.POST_IMBALANCE],
 *   onPhase: async (phase, context) => {
 *     if (phase === Phase.POST_IMBALANCE) {
 *       // Simulate crash by not running rebalancer
 *       // Verify state is recoverable
 *     }
 *   },
 * });
 * ```
 */

import { RebalancerTestSetup } from './setup.js';

/**
 * Phases in the rebalancer lifecycle.
 */
export enum Phase {
  /** Initial state - no imbalance exists */
  INITIAL = 'INITIAL',

  /** After imbalance created (e.g., transferRemote executed) */
  POST_IMBALANCE = 'POST_IMBALANCE',

  /** Rebalancer has detected imbalance, computed routes */
  ROUTES_COMPUTED = 'ROUTES_COMPUTED',

  /** Rebalance transaction submitted but not confirmed */
  TX_PENDING = 'TX_PENDING',

  /** Rebalance transaction confirmed on origin */
  TX_CONFIRMED = 'TX_CONFIRMED',

  /** Bridge transfer initiated */
  BRIDGE_INITIATED = 'BRIDGE_INITIATED',

  /** Bridge transfer completed, funds arrived */
  BRIDGE_COMPLETED = 'BRIDGE_COMPLETED',

  /** Final balanced state */
  BALANCED = 'BALANCED',
}

/**
 * Context passed to phase handlers.
 */
export interface PhaseContext {
  setup: RebalancerTestSetup;
  phase: Phase;

  /** Balances at this phase, keyed by domain name */
  balances: Record<string, bigint>;

  /** Computed routes (available after ROUTES_COMPUTED) */
  routes?: Array<{
    origin: string;
    destination: string;
    amount: bigint;
  }>;

  /** Transaction hash (available after TX_PENDING) */
  txHash?: string;

  /** Any error that occurred */
  error?: Error;
}

/**
 * Handler called at each phase.
 * Return false to stop execution, true to continue.
 */
export type PhaseHandler = (context: PhaseContext) => Promise<boolean | void>;

/**
 * Options for phase-based test execution.
 */
export interface PhaseRunnerOptions {
  /**
   * Phases to execute. Runner stops after the last phase in this list.
   */
  phases: Phase[];

  /**
   * Handler called at each phase.
   * Can be used to verify state, inject faults, or simulate crashes.
   */
  onPhase?: PhaseHandler;

  /**
   * Function to create imbalance (called between INITIAL and POST_IMBALANCE).
   */
  createImbalance?: () => Promise<void>;

  /**
   * Function to compute rebalancing routes.
   */
  computeRoutes?: () => Promise<
    Array<{ origin: string; destination: string; amount: bigint }>
  >;

  /**
   * Function to execute rebalance transaction.
   */
  executeRebalance?: (
    routes: Array<{ origin: string; destination: string; amount: bigint }>,
  ) => Promise<string>;

  /**
   * Function to complete bridge transfer (for testing).
   */
  completeBridge?: () => Promise<void>;
}

/**
 * Result of a phase-based test run.
 */
export interface PhaseRunResult {
  /** Last phase that was executed */
  lastPhase: Phase;

  /** Whether all requested phases completed */
  completed: boolean;

  /** Final context */
  context: PhaseContext;

  /** Phase at which execution stopped (if not completed) */
  stoppedAt?: Phase;
}

/**
 * Creates a phase runner for testing rebalancer at different lifecycle stages.
 */
export function createPhaseRunner(setup: RebalancerTestSetup) {
  return {
    /**
     * Run through phases, calling handlers at each stage.
     */
    async runWithPhases(options: PhaseRunnerOptions): Promise<PhaseRunResult> {
      const {
        phases,
        onPhase,
        createImbalance,
        computeRoutes,
        executeRebalance,
        completeBridge,
      } = options;

      // Get initial balances
      const getBalances = async (): Promise<Record<string, bigint>> => {
        const balances: Record<string, bigint> = {};
        for (const [domainName, token] of Object.entries(setup.tokens)) {
          const warpRouteAddress = setup.warpRoutes[domainName];
          if (warpRouteAddress) {
            balances[domainName] = (
              await token.balanceOf(warpRouteAddress)
            ).toBigInt();
          }
        }
        return balances;
      };

      let context: PhaseContext = {
        setup,
        phase: Phase.INITIAL,
        balances: await getBalances(),
      };

      const phaseOrder = [
        Phase.INITIAL,
        Phase.POST_IMBALANCE,
        Phase.ROUTES_COMPUTED,
        Phase.TX_PENDING,
        Phase.TX_CONFIRMED,
        Phase.BRIDGE_INITIATED,
        Phase.BRIDGE_COMPLETED,
        Phase.BALANCED,
      ];

      let lastPhase = Phase.INITIAL;
      let stoppedAt: Phase | undefined;

      for (const phase of phaseOrder) {
        // Skip phases not in the requested list
        if (!phases.includes(phase)) {
          // But still execute transitions if we haven't reached our stop point
          const maxRequestedIndex = Math.max(
            ...phases.map((p) => phaseOrder.indexOf(p)),
          );
          if (phaseOrder.indexOf(phase) > maxRequestedIndex) {
            break;
          }
          continue;
        }

        context.phase = phase;
        context.balances = await getBalances();

        // Execute phase transition logic
        try {
          switch (phase) {
            case Phase.INITIAL:
              // Nothing to do
              break;

            case Phase.POST_IMBALANCE:
              if (createImbalance) {
                await createImbalance();
                context.balances = await getBalances();
              }
              break;

            case Phase.ROUTES_COMPUTED:
              if (computeRoutes) {
                context.routes = await computeRoutes();
              }
              break;

            case Phase.TX_PENDING:
              if (executeRebalance && context.routes) {
                context.txHash = await executeRebalance(context.routes);
              }
              break;

            case Phase.TX_CONFIRMED:
              // Transaction is confirmed (implied by executeRebalance returning)
              context.balances = await getBalances();
              break;

            case Phase.BRIDGE_INITIATED:
              // Bridge transfer started
              break;

            case Phase.BRIDGE_COMPLETED:
              if (completeBridge) {
                await completeBridge();
                context.balances = await getBalances();
              }
              break;

            case Phase.BALANCED:
              // Final state
              context.balances = await getBalances();
              break;
          }
        } catch (error) {
          context.error = error as Error;
          stoppedAt = phase;
          break;
        }

        // Call phase handler
        if (onPhase) {
          const shouldContinue = await onPhase(context);
          if (shouldContinue === false) {
            stoppedAt = phase;
            break;
          }
        }

        lastPhase = phase;
      }

      return {
        lastPhase,
        completed: !stoppedAt && phases.includes(lastPhase),
        context,
        stoppedAt,
      };
    },
  };
}

/**
 * Helper to create a crash simulation at a specific phase.
 *
 * @example
 * ```typescript
 * const crashAt = simulateCrashAt(Phase.TX_PENDING);
 * await runner.runWithPhases({
 *   phases: [Phase.INITIAL, Phase.POST_IMBALANCE, Phase.TX_PENDING],
 *   onPhase: crashAt,
 * });
 * ```
 */
export function simulateCrashAt(crashPhase: Phase): PhaseHandler {
  return async (context) => {
    if (context.phase === crashPhase) {
      // Return false to stop execution, simulating a crash
      return false;
    }
    return true;
  };
}

/**
 * Helper to capture state at specific phases for later comparison.
 */
export function captureStateAt(
  targetPhases: Phase[],
): {
  handler: PhaseHandler;
  states: Map<Phase, PhaseContext>;
} {
  const states = new Map<Phase, PhaseContext>();

  const handler: PhaseHandler = async (context) => {
    if (targetPhases.includes(context.phase)) {
      // Deep copy the context
      states.set(context.phase, {
        ...context,
        balances: { ...context.balances },
        routes: context.routes ? [...context.routes] : undefined,
      });
    }
    return true;
  };

  return { handler, states };
}
