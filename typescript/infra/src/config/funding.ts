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

export interface SweepOverrideConfig {
  // Address to sweep funds to (overrides default)
  sweepAddress?: string;
  // Multiplier for the target balance to leave after sweeping (overrides default 1.5)
  targetMultiplier?: number;
  // Multiplier for the trigger threshold to initiate sweep (overrides default 2.0)
  triggerMultiplier?: number;
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
