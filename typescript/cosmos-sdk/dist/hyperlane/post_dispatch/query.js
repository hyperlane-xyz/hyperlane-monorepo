import { createProtobufRpcClient } from '@cosmjs/stargate';

import { pdQuery } from '@hyperlane-xyz/cosmos-types';

export function setupPostDispatchExtension(base) {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new pdQuery.QueryClientImpl(rpc);
  return {
    postDispatch: {
      DestinationGasConfigs: (req) => queryService.DestinationGasConfigs(req),
      Igps: (req) => queryService.Igps(req),
      Igp: (req) => queryService.Igp(req),
      MerkleTreeHooks: (req) => queryService.MerkleTreeHooks(req),
      MerkleTreeHook: (req) => queryService.MerkleTreeHook(req),
      NoopHooks: (req) => queryService.NoopHooks(req),
      NoopHook: (req) => queryService.NoopHook(req),
      QuoteGasPayment: (req) => queryService.QuoteGasPayment(req),
    },
  };
}
//# sourceMappingURL=query.js.map
