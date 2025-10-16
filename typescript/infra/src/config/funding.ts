import { z } from 'zod';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { FundableRole, Role } from '../roles.js';

import { DockerConfig } from './agent/agent.js';

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

export interface KeyFunderConfig<SupportedChains extends readonly ChainName[]>
  extends CronJobConfig {
  contextFundingFrom: Contexts;
  contextsAndRolesToFund: ContextAndRolesMap;
  cyclesBetweenEthereumMessages?: number;
  desiredBalancePerChain: Record<SupportedChains[number], string>;
  desiredKathyBalancePerChain: ChainMap<string>;
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
const SweepOverrideConfigSchema = z
  .object({
    sweepAddress: z.string().optional(),
    targetMultiplier: z
      .number()
      .gt(1, 'Target multiplier must be greater than 1.0')
      .optional(),
    triggerMultiplier: z
      .number()
      .gt(1.1, 'Trigger multiplier must be greater than 1.1')
      .optional(),
  })
  .refine(
    (data) => {
      // Enforce: trigger multiplier must be greater than target multiplier
      if (
        typeof data.targetMultiplier === 'number' &&
        typeof data.triggerMultiplier === 'number'
      ) {
        return data.triggerMultiplier > data.targetMultiplier;
      }
      return true;
    },
    {
      message: 'Trigger multiplier must be greater than target multiplier',
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
