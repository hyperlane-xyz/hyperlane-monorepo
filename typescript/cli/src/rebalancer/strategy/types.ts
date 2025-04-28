import { ChainName } from '@hyperlane-xyz/sdk';

/**
 * Per chain configuration for the strategy
 */
export type StrategyConfig = Record<
  ChainName,
  {
    /**
     * How much in % of the total balance the chain should have
     */
    weight: bigint;
    /**
     * How much in % of the target balance a deficitary chain can
     * deviate before being considered unbalanced
     */
    tolerance: bigint;
  }
>;

/**
 * The amount of tokens that a chain deviates from the target balance
 */
export type Delta = { chain: ChainName; amount: bigint };
