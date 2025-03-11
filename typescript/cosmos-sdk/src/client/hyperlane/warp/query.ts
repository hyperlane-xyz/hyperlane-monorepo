import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import {
  QueryBridgedSupplyRequest,
  QueryBridgedSupplyResponse,
  QueryClientImpl,
  QueryQuoteRemoteTransferRequest,
  QueryQuoteRemoteTransferResponse,
  QueryRemoteRoutersRequest,
  QueryRemoteRoutersResponse,
  QueryTokenRequest,
  QueryTokenResponse,
  QueryTokensRequest,
  QueryTokensResponse,
} from '../../../types/hyperlane/warp/v1/query';

export interface WarpExtension {
  readonly warp: {
    /** Returns all registered tokens */
    readonly Tokens: (req: QueryTokensRequest) => Promise<QueryTokensResponse>;
    /** Returns a specific token by ID */
    readonly Token: (req: QueryTokenRequest) => Promise<QueryTokenResponse>;
    /** RemoteRouters ... */
    readonly RemoteRouters: (
      req: QueryRemoteRoutersRequest,
    ) => Promise<QueryRemoteRoutersResponse>;
    /** BridgedSupply ... */
    readonly BridgedSupply: (
      req: QueryBridgedSupplyRequest,
    ) => Promise<QueryBridgedSupplyResponse>;
    /** QuoteRemoteTransfer ... */
    readonly QuoteRemoteTransfer: (
      req: QueryQuoteRemoteTransferRequest,
    ) => Promise<QueryQuoteRemoteTransferResponse>;
  };
}

export function setupWarpExtension(base: QueryClient): WarpExtension {
  const rpc = createProtobufRpcClient(base);
  const queryService = new QueryClientImpl(rpc);

  return {
    warp: {
      Tokens: (req: QueryTokensRequest) => queryService.Tokens(req),
      Token: (req: QueryTokenRequest) => queryService.Token(req),
      RemoteRouters: (req: QueryRemoteRoutersRequest) =>
        queryService.RemoteRouters(req),
      BridgedSupply: (req: QueryBridgedSupplyRequest) =>
        queryService.BridgedSupply(req),
      QuoteRemoteTransfer: (req: QueryQuoteRemoteTransferRequest) =>
        queryService.QuoteRemoteTransfer(req),
    },
  };
}
