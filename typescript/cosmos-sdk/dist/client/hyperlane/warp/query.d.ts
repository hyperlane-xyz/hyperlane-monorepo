import { QueryClient } from '@cosmjs/stargate';

import {
  QueryBridgedSupplyRequest,
  QueryBridgedSupplyResponse,
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
export declare function setupWarpExtension(base: QueryClient): WarpExtension;
