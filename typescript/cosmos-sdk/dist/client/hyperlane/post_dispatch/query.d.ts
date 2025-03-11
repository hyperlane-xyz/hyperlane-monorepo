import { QueryClient } from '@cosmjs/stargate';

import {
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
} from '../../../types/hyperlane/core/post_dispatch/v1/query';

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
export declare function setupPostDispatchExtension(
  base: QueryClient,
): PostDispatchExtension;
