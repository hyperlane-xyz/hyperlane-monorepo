import { join } from 'path';

import { ChainMap } from '@hyperlane-xyz/sdk';

import { getInfraPath } from '../../utils/utils.js';

export enum BalanceThresholdType {
  DesiredRelayerBalance = 'desiredRelayerBalances',
  LowUrgencyKeyFunderBalance = 'lowUrgencyKeyFunderBalance',
  LowUrgencyEngKeyFunderBalance = 'lowUrgencyEngKeyFunderBalance',
  HighUrgencyRelayerBalance = 'highUrgencyRelayerBalance',
}

interface BalanceThresholdConfig {
  configFileName: string;
  dailyRelayerBurnMultiplier: number;
  choiceLabel: string;
  // indicates which threshold should be largest relative to others, .e.g. 1 is the largest, 2 is the second largest, etc.
  weight: number;
}

export const THRESHOLD_CONFIG_PATH = join(
  getInfraPath(),
  'config/environments/mainnet3/balances',
);

export const RELAYER_BALANCE_TARGET_DAYS = 8;
const RELAYER_MIN_DOLLAR_BALANCE_TARGET = 25;
export const RELAYER_MIN_DOLLAR_BALANCE_PER_DAY =
  RELAYER_MIN_DOLLAR_BALANCE_TARGET / RELAYER_BALANCE_TARGET_DAYS;

export const balanceThresholdConfigMapping: Record<
  BalanceThresholdType,
  BalanceThresholdConfig
> = {
  [BalanceThresholdType.DesiredRelayerBalance]: {
    configFileName: `${BalanceThresholdType.DesiredRelayerBalance}.json`,
    dailyRelayerBurnMultiplier: RELAYER_BALANCE_TARGET_DAYS,
    choiceLabel: 'Desired Relayer Balance',
    weight: 2,
  },
  [BalanceThresholdType.LowUrgencyKeyFunderBalance]: {
    configFileName: `${[BalanceThresholdType.LowUrgencyKeyFunderBalance]}.json`,
    dailyRelayerBurnMultiplier: 12,
    choiceLabel: 'Low Urgency Key Funder Balance',
    weight: 1,
  },
  [BalanceThresholdType.LowUrgencyEngKeyFunderBalance]: {
    configFileName: `${BalanceThresholdType.LowUrgencyEngKeyFunderBalance}.json`,
    dailyRelayerBurnMultiplier: 6,
    choiceLabel: 'Low Urgency Eng Key Funder Balance',
    weight: 3,
  },
  [BalanceThresholdType.HighUrgencyRelayerBalance]: {
    configFileName: `${BalanceThresholdType.HighUrgencyRelayerBalance}.json`,
    dailyRelayerBurnMultiplier: 2,
    choiceLabel: 'High Urgency Relayer Balance',
    weight: 4,
  },
};

export interface ManualReview {
  chain: string;
  proposedThreshold: number;
  currentThreshold: number;
}

interface ThresholdConfig {
  thresholds: ChainMap<string>;
  manualReview?: ManualReview[];
}

export type ThresholdConfigs = Record<BalanceThresholdType, ThresholdConfig>;
