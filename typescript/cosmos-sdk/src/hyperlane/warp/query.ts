import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import { warpQuery } from '@hyperlane-xyz/cosmos-types';

export interface WarpExtension {
  readonly warp: {
    /** Returns all registered tokens */
    readonly Tokens: (
      req: warpQuery.QueryTokensRequest,
    ) => Promise<warpQuery.QueryTokensResponse>;
    /** Returns a specific token by ID */
    readonly Token: (
      req: warpQuery.QueryTokenRequest,
    ) => Promise<warpQuery.QueryTokenResponse>;
    /** RemoteRouters ... */
    readonly RemoteRouters: (
      req: warpQuery.QueryRemoteRoutersRequest,
    ) => Promise<warpQuery.QueryRemoteRoutersResponse>;
    /** BridgedSupply ... */
    readonly BridgedSupply: (
      req: warpQuery.QueryBridgedSupplyRequest,
    ) => Promise<warpQuery.QueryBridgedSupplyResponse>;
    /** QuoteRemoteTransfer ... */
    readonly QuoteRemoteTransfer: (
      req: warpQuery.QueryQuoteRemoteTransferRequest,
    ) => Promise<warpQuery.QueryQuoteRemoteTransferResponse>;
  };
}

export function setupWarpExtension(base: QueryClient): WarpExtension {
  const rpc = createProtobufRpcClient(base);
  const queryService = new warpQuery.QueryClientImpl(rpc);

  return {
    warp: {
      Tokens: (req: warpQuery.QueryTokensRequest) => queryService.Tokens(req),
      Token: (req: warpQuery.QueryTokenRequest) => queryService.Token(req),
      RemoteRouters: (req: warpQuery.QueryRemoteRoutersRequest) =>
        queryService.RemoteRouters(req),
      BridgedSupply: (req: warpQuery.QueryBridgedSupplyRequest) =>
        queryService.BridgedSupply(req),
      QuoteRemoteTransfer: (req: warpQuery.QueryQuoteRemoteTransferRequest) =>
        queryService.QuoteRemoteTransfer(req),
    },
  };
}
