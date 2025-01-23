export enum BalanceThresholdConfig {
  RelayerBalance = 'relayerBalance',
  LowUrgencyKeyFunderBalance = 'lowUrgencyKeyFunderBalance',
  LowUrgencyEngKeyFunderBalance = 'lowUrgencyEngKeyFunderBalance',
  HighUrgencyRelayerBalance = 'highUrgencyRelayerBalance',
}

export const configFileNameMapping: Record<BalanceThresholdConfig, string> = {
  [BalanceThresholdConfig.RelayerBalance]: 'desiredBalances.json',
  [BalanceThresholdConfig.LowUrgencyKeyFunderBalance]:
    'lowUrgencyKeyFunderBalance.json',
  [BalanceThresholdConfig.LowUrgencyEngKeyFunderBalance]:
    'lowUrgencyEngKeyFunderBalance.json',
  [BalanceThresholdConfig.HighUrgencyRelayerBalance]:
    'highUrgencyRelayerBalance.json',
};

export const RELAYER_BALANCE_TARGET_DAYS = 8;
export const LOW_URGENCY_KEY_FUNDER_BALANCE_TARGET_DAYS = 12;
export const LOW_URGENCY_ENG_KEY_FUNDER_BALANCE_TARGET_DAYS = 6;
export const HIGH_URGENCY_RELAYER_BALANCE_TARGET_DAYS = 2;
export const RELAYER_MIN_DOLLAR_BALANCE_TARGET = 25;
export const RELAYER_MIN_DOLLAR_BALANCE_PER_DAY =
  RELAYER_MIN_DOLLAR_BALANCE_TARGET / RELAYER_BALANCE_TARGET_DAYS;

export const dailyBurnMultiplier: Record<BalanceThresholdConfig, number> = {
  [BalanceThresholdConfig.RelayerBalance]: RELAYER_BALANCE_TARGET_DAYS,
  [BalanceThresholdConfig.LowUrgencyKeyFunderBalance]:
    LOW_URGENCY_KEY_FUNDER_BALANCE_TARGET_DAYS,
  [BalanceThresholdConfig.LowUrgencyEngKeyFunderBalance]:
    LOW_URGENCY_ENG_KEY_FUNDER_BALANCE_TARGET_DAYS,
  [BalanceThresholdConfig.HighUrgencyRelayerBalance]:
    HIGH_URGENCY_RELAYER_BALANCE_TARGET_DAYS,
};
