'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.setupWarpExtension = setupWarpExtension;
const stargate_1 = require('@cosmjs/stargate');
const query_1 = require('../../../types/hyperlane/warp/v1/query');
function setupWarpExtension(base) {
  const rpc = (0, stargate_1.createProtobufRpcClient)(base);
  const queryService = new query_1.QueryClientImpl(rpc);
  return {
    warp: {
      Tokens: (req) => queryService.Tokens(req),
      Token: (req) => queryService.Token(req),
      RemoteRouters: (req) => queryService.RemoteRouters(req),
      BridgedSupply: (req) => queryService.BridgedSupply(req),
      QuoteRemoteTransfer: (req) => queryService.QuoteRemoteTransfer(req),
    },
  };
}
//# sourceMappingURL=query.js.map
