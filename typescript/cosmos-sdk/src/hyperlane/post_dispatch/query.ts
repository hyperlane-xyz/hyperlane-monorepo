import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

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

export function setupPostDispatchExtension(
  base: QueryClient,
): PostDispatchExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new pdQuery.QueryClientImpl(rpc);
  return {
    postDispatch: {
      DestinationGasConfigs: (req: pdQuery.QueryDestinationGasConfigsRequest) =>
        queryService.DestinationGasConfigs(req),
      Igps: (req: pdQuery.QueryIgpsRequest) => queryService.Igps(req),
      Igp: (req: pdQuery.QueryIgpRequest) => queryService.Igp(req),
      MerkleTreeHooks: (req: pdQuery.QueryMerkleTreeHooksRequest) =>
        queryService.MerkleTreeHooks(req),
      MerkleTreeHook: (req: pdQuery.QueryMerkleTreeHookRequest) =>
        queryService.MerkleTreeHook(req),
      NoopHooks: (req: pdQuery.QueryNoopHooksRequest) =>
        queryService.NoopHooks(req),
      NoopHook: (req: pdQuery.QueryNoopHookRequest) =>
        queryService.NoopHook(req),
      QuoteGasPayment: (req: pdQuery.QueryQuoteGasPaymentRequest) =>
        queryService.QuoteGasPayment(req),
    },
  };
}
