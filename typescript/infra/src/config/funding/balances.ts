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
  },
  [BalanceThresholdType.LowUrgencyKeyFunderBalance]: {
    configFileName: `${[BalanceThresholdType.LowUrgencyKeyFunderBalance]}.json`,
    dailyRelayerBurnMultiplier: 12,
    choiceLabel: 'Low Urgency Key Funder Balance',
  },
  [BalanceThresholdType.LowUrgencyEngKeyFunderBalance]: {
    configFileName: `${BalanceThresholdType.LowUrgencyEngKeyFunderBalance}.json`,
    dailyRelayerBurnMultiplier: 6,
    choiceLabel: 'Low Urgency Eng Key Funder Balance',
  },
  [BalanceThresholdType.HighUrgencyRelayerBalance]: {
    configFileName: `${BalanceThresholdType.HighUrgencyRelayerBalance}.json`,
    dailyRelayerBurnMultiplier: 2,
    choiceLabel: 'High Urgency Relayer Balance',
  },
};

export type ThresholdsData = Record<BalanceThresholdType, ChainMap<number>>;
