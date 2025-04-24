import { createProtobufRpcClient } from '@cosmjs/stargate';

import { warpQuery } from '@hyperlane-xyz/cosmos-types';

export function setupWarpExtension(base) {
  const rpc = createProtobufRpcClient(base);
  const queryService = new warpQuery.QueryClientImpl(rpc);
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
