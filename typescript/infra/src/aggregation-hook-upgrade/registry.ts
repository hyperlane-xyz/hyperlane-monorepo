import type { ChainAddresses } from '@hyperlane-xyz/registry';
import { Address, objMerge } from '@hyperlane-xyz/utils';

export interface RegistryAddressUpdate {
  staticAggregationHookFactory?: Address;
  aggregationHook?: Address;
  interchainAccountRouter?: Address;
  quotedCalls?: Address;
}

// The registry overwrites addresses.yaml with exactly what it is given, so the
// update is merged into the full current map instead of being written alone.
export function buildRegistryAddresses(
  current: ChainAddresses,
  update: RegistryAddressUpdate,
): ChainAddresses {
  const changes: ChainAddresses = {};
  if (update.staticAggregationHookFactory !== undefined) {
    changes.staticAggregationHookFactory = update.staticAggregationHookFactory;
  }
  if (update.aggregationHook !== undefined) {
    changes.aggregationHook = update.aggregationHook;
  }
  if (update.interchainAccountRouter !== undefined) {
    changes.interchainAccountRouter = update.interchainAccountRouter;
  }
  if (update.quotedCalls !== undefined) {
    changes.quotedCalls = update.quotedCalls;
  }
  return objMerge<ChainAddresses>(current, changes);
}
