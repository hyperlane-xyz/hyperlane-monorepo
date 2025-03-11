'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.setupPostDispatchExtension = setupPostDispatchExtension;
const stargate_1 = require('@cosmjs/stargate');
const query_1 = require('../../../types/hyperlane/core/post_dispatch/v1/query');
function setupPostDispatchExtension(base) {
  const rpc = (0, stargate_1.createProtobufRpcClient)(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const queryService = new query_1.QueryClientImpl(rpc);
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
