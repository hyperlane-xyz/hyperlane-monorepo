import { z } from 'zod';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { FundableRole, Role } from '../roles.js';

import { DockerConfig } from './agent/agent.js';

/**
 * Default address for sweeping excess funds from the keyfunder wallet.
 * This is a Hyperlane-controlled Safe address used to collect surplus funds
 * when the keyfunder wallet balance exceeds the configured threshold.
 * Can be overridden per-chain via sweepOverrides config.
 */
export const DEFAULT_SWEEP_ADDRESS =
  '0x478be6076f31E9666123B9721D0B6631baD944AF';

export interface ContextAndRoles {
  context: Contexts;
  roles: Role[];
}

export type ContextAndRolesMap = Partial<Record<Contexts, FundableRole[]>>;

export interface CronJobConfig {
  docker: DockerConfig;
  cronSchedule: string;
  namespace: string;
  prometheusPushGateway: string;
}

export interface KeyFunderConfig<
  SupportedChains extends readonly ChainName[],
> extends CronJobConfig {
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  desiredBalancePerChain: Record<SupportedChains[number], string>;
  desiredRebalancerBalancePerChain: ChainMap<string>;
  igpClaimThresholdPerChain: ChainMap<string>;
  chainsToSkip: ChainName[];
  // Per-chain overrides for automatic sweep of excess funds to Safes
  // Defaults: sweep to 0x478be6076f31E9666123B9721D0B6631baD944AF when balance > 2x threshold, leave behind 1.5x threshold
  sweepOverrides?: ChainMap<SweepOverrideConfig>;
  // Low urgency key funder balance thresholds for sweep calculations
  lowUrgencyKeyFunderBalances?: ChainMap<string>;
}

export interface CheckWarpDeployConfig extends CronJobConfig {
  registryCommit?: string;
}

// Zod validation schema for sweep override configuration
export type SweepOverrideConfig = z.infer<typeof SweepOverrideConfigSchema>;

const MIN_TRIGGER_DIFFERENCE = 0.05;
const MIN_TARGET = 1.05;
const MIN_TRIGGER = 1.1;
const MAX_TARGET = 10.0;
const MAX_TRIGGER = 200.0;

const SweepOverrideConfigSchema = z
  .object({
    sweepAddress: z
      .string()
      .regex(
        /^0x[a-fA-F0-9]{40}$/,
        'sweepAddress must be a valid Ethereum address (0x-prefixed, 40 hex characters)',
      )
      .optional(),
    targetMultiplier: z
      .number()
      .min(MIN_TARGET, `Target multiplier must be at least ${MIN_TARGET}`)
      .max(MAX_TARGET, `Target multiplier must be at most ${MAX_TARGET}`)
      .optional(),
    triggerMultiplier: z
      .number()
      .min(MIN_TRIGGER, `Trigger multiplier must be at least ${MIN_TRIGGER}`)
      .max(MAX_TRIGGER, `Trigger multiplier must be at most ${MAX_TRIGGER}`)
      .optional(),
  })
  .refine(
    (data) => {
      // Check both provided
      if (
        typeof data.targetMultiplier === 'number' &&
        typeof data.triggerMultiplier === 'number'
      ) {
        // Enforce: trigger multiplier must be at least MIN_TRIGGER_DIFFERENCE greater than target
        return (
          data.triggerMultiplier >=
          data.targetMultiplier + MIN_TRIGGER_DIFFERENCE
        );
      }
      return true;
    },
    {
      message: `Trigger multiplier must be at least ${MIN_TRIGGER_DIFFERENCE} greater than target multiplier`,
      path: ['triggerMultiplier'],
    },
  );

/**
 * Validates a single sweep override configuration using Zod schema.
 * Ensures multipliers are within reasonable bounds and trigger > target.
 *
 * @param config - The sweep override configuration to validate
 * @returns Validated SweepOverrideConfig
 * @throws Error if validation fails with formatted error message
 */
export function validateSweepConfig(config: unknown): SweepOverrideConfig {
  return SweepOverrideConfigSchema.parse(config);
}
