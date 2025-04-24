import { QueryClient } from '@cosmjs/stargate';

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
export declare function setupWarpExtension(base: QueryClient): WarpExtension;
//# sourceMappingURL=query.d.ts.map
