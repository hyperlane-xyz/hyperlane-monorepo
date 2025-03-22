import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import {
  QueryClientImpl,
  QueryDestinationGasConfigsRequest,
  QueryDestinationGasConfigsResponse,
  QueryIgpRequest,
  QueryIgpResponse,
  QueryIgpsRequest,
  QueryIgpsResponse,
  QueryMerkleTreeHook,
  QueryMerkleTreeHookResponse,
  QueryMerkleTreeHooks,
  QueryMerkleTreeHooksResponse,
  QueryNoopHookRequest,
  QueryNoopHookResponse,
  QueryNoopHooksRequest,
  QueryNoopHooksResponse,
  QueryQuoteGasPaymentRequest,
  QueryQuoteGasPaymentResponse,
} from '../../../types/hyperlane/core/post_dispatch/v1/query.js';

export interface PostDispatchExtension {
  readonly postDispatch: {
    /** DestinationGasConfigs ... */
    readonly DestinationGasConfigs: (
      req: QueryDestinationGasConfigsRequest,
    ) => Promise<QueryDestinationGasConfigsResponse>;
    /** Igps */
    readonly Igps: (req: QueryIgpsRequest) => Promise<QueryIgpsResponse>;
    /** Igp ... */
    readonly Igp: (req: QueryIgpRequest) => Promise<QueryIgpResponse>;
    /** MerkleTreeHooks */
    readonly MerkleTreeHooks: (
      req: QueryMerkleTreeHooks,
    ) => Promise<QueryMerkleTreeHooksResponse>;
    /** MerkleTreeHook ... */
    readonly MerkleTreeHook: (
      req: QueryMerkleTreeHook,
    ) => Promise<QueryMerkleTreeHookResponse>;
    /** NoopHooks */
    readonly NoopHooks: (
      req: QueryNoopHooksRequest,
    ) => Promise<QueryNoopHooksResponse>;
    /** NoopHook ... */
    readonly NoopHook: (
      req: QueryNoopHookRequest,
    ) => Promise<QueryNoopHookResponse>;
    /** NoopHook ... */
    readonly QuoteGasPayment: (
      req: QueryQuoteGasPaymentRequest,
    ) => Promise<QueryQuoteGasPaymentResponse>;
  };
}

export function setupPostDispatchExtension(
  base: QueryClient,
): PostDispatchExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new QueryClientImpl(rpc);
  return {
    postDispatch: {
      DestinationGasConfigs: (req: QueryDestinationGasConfigsRequest) =>
        queryService.DestinationGasConfigs(req),
      Igps: (req: QueryIgpsRequest) => queryService.Igps(req),
      Igp: (req: QueryIgpRequest) => queryService.Igp(req),
      MerkleTreeHooks: (req: QueryMerkleTreeHooks) =>
        queryService.MerkleTreeHooks(req),
      MerkleTreeHook: (req: QueryMerkleTreeHook) =>
        queryService.MerkleTreeHook(req),
      NoopHooks: (req: QueryNoopHooksRequest) => queryService.NoopHooks(req),
      NoopHook: (req: QueryNoopHookRequest) => queryService.NoopHook(req),
      QuoteGasPayment: (req: QueryQuoteGasPaymentRequest) =>
        queryService.QuoteGasPayment(req),
    },
  };
}
