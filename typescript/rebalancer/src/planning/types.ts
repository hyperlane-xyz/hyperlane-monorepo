import type { ChainName } from '@hyperlane-xyz/sdk';

export type BalanceDelta = {
  chain: ChainName;
  amount: bigint;
};
