import { QueryClient } from '@cosmjs/stargate';

import { pdQuery } from '@hyperlane-xyz/cosmos-types';

export interface PostDispatchExtension {
  readonly postDispatch: {
    /** DestinationGasConfigs ... */
    readonly DestinationGasConfigs: (
      req: pdQuery.QueryDestinationGasConfigsRequest,
    ) => Promise<pdQuery.QueryDestinationGasConfigsResponse>;
    /** Igps */
    readonly Igps: (
      req: pdQuery.QueryIgpsRequest,
    ) => Promise<pdQuery.QueryIgpsResponse>;
    /** Igp ... */
    readonly Igp: (
      req: pdQuery.QueryIgpRequest,
    ) => Promise<pdQuery.QueryIgpResponse>;
    /** MerkleTreeHooks */
    readonly MerkleTreeHooks: (
      req: pdQuery.QueryMerkleTreeHooksRequest,
    ) => Promise<pdQuery.QueryMerkleTreeHooksResponse>;
    /** MerkleTreeHook ... */
    readonly MerkleTreeHook: (
      req: pdQuery.QueryMerkleTreeHookRequest,
    ) => Promise<pdQuery.QueryMerkleTreeHookResponse>;
    /** NoopHooks */
    readonly NoopHooks: (
      req: pdQuery.QueryNoopHooksRequest,
    ) => Promise<pdQuery.QueryNoopHooksResponse>;
    /** NoopHook ... */
    readonly NoopHook: (
      req: pdQuery.QueryNoopHookRequest,
    ) => Promise<pdQuery.QueryNoopHookResponse>;
    /** NoopHook ... */
    readonly QuoteGasPayment: (
      req: pdQuery.QueryQuoteGasPaymentRequest,
    ) => Promise<pdQuery.QueryQuoteGasPaymentResponse>;
  };
}
export declare function setupPostDispatchExtension(
  base: QueryClient,
): PostDispatchExtension;
//# sourceMappingURL=query.d.ts.map
