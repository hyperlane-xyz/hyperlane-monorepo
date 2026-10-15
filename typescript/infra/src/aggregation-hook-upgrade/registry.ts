import type { ChainAddresses } from '@hyperlane-xyz/registry';
import { Address, objMerge } from '@hyperlane-xyz/utils';

export interface RegistryAddressUpdate {
  staticAggregationHookFactory?: Address;
  aggregationHook?: Address;
  interchainAccountRouterV3?: Address;
  quotedCallsV3?: Address;
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
  if (update.interchainAccountRouterV3 !== undefined) {
    changes.interchainAccountRouterV3 = update.interchainAccountRouterV3;
  }
  if (update.quotedCallsV3 !== undefined) {
    changes.quotedCallsV3 = update.quotedCallsV3;
  }
  return objMerge<ChainAddresses>(current, changes);
}
