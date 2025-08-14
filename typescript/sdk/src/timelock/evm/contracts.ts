import { TimelockController__factory } from '@hyperlane-xyz/core';

export const evmTimelockFactories = {
  TimelockController: new TimelockController__factory(),
} as const;

export type EvmTimelockFactories = typeof evmTimelockFactories;
