import type { ChainName } from '@hyperlane-xyz/sdk';

import type { RebalanceIntent } from '../tracking/types.js';

/**
 * Route for an inventory-based rebalance operation.
 *
 * Strategy semantics: origin (surplus) → destination (deficit)
 * "Move collateral FROM origin TO destination"
 */
export interface InventoryRoute {
  origin: ChainName; // Surplus chain (has excess collateral to release)
  destination: ChainName; // Deficit chain (needs collateral added)
  amount: bigint; // Amount to rebalance
}

/**
 * Result of executing an inventory route.
 */
export interface InventoryExecutionResult {
  route: InventoryRoute;
  intent: RebalanceIntent;
  success: boolean;
  /** Actual amount sent (may differ from route.amount for partial executions) */
  amountSent?: bigint;
  error?: string;
  /** Reason for completion (e.g., 'completed_with_acceptable_loss' when small remaining is forgiven) */
  reason?: string;
}

/**
 * Interface for executing inventory-based rebalances.
 *
 * The InventoryRebalancer handles rebalancing for chains that don't support
 * MovableCollateralRouter (e.g., Solana). It processes ONE intent at a time:
 *
 * 1. If an in_progress intent exists, continue it (ignore new routes)
 * 2. If no intent exists, take the FIRST route only, create an intent, and execute
 *
 * IMPORTANT: transferRemote ADDS collateral to the chain it's called FROM.
 * So for a strategy route "origin (surplus) → destination (deficit)":
 *
 * 1. Check if inventory is available on the DESTINATION (deficit) chain
 * 2. If not, create an inventory_movement action to bridge inventory TO destination
 * 3. Once inventory is on destination, create an inventory_deposit action
 *    which calls transferRemote FROM destination TO origin (swapped direction!)
 *
 * This results in:
 * - Collateral ADDED to destination (deficit filled!)
 * - Collateral RELEASED from origin (surplus reduced)
 */
export interface IInventoryRebalancer {
  /**
   * Execute inventory-based rebalances for the given routes.
   *
   * Only ONE route/intent is processed at a time:
   * - If an in_progress intent exists, continue it (routes are ignored)
   * - Otherwise, take only the FIRST route, create an intent, and execute
   *
   * @param routes - Routes proposed by strategy (only first is used if no active intent)
   * @returns Execution results (single result for the executed route)
   */
  execute(routes: InventoryRoute[]): Promise<InventoryExecutionResult[]>;

  /**
   * Check if a route can be executed with current inventory.
   * Returns the amount that can be fulfilled immediately.
   *
   * @param route - Route to check
   * @returns Amount that can be fulfilled with available inventory
   */
  getAvailableAmount(route: InventoryRoute): Promise<bigint>;
}
