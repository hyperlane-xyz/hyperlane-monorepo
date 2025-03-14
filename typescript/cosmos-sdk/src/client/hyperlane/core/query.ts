import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import {
  QueryClientImpl,
  QueryDeliveredRequest,
  QueryDeliveredResponse,
  QueryMailboxRequest,
  QueryMailboxResponse,
  QueryMailboxesRequest,
  QueryMailboxesResponse,
  QueryVerifyDryRunRequest,
  QueryVerifyDryRunResponse,
  RecipientIsmRequest,
  RecipientIsmResponse,
} from '../../../types/hyperlane/core/v1/query';

export interface CoreExtension {
  readonly core: {
    /** Mailboxes ... */
    readonly Mailboxes: (
      req: QueryMailboxesRequest,
    ) => Promise<QueryMailboxesResponse>;
    /** Mailbox ... */
    readonly Mailbox: (
      req: QueryMailboxRequest,
    ) => Promise<QueryMailboxResponse>;
    /** Delivered ... */
    readonly Delivered: (
      req: QueryDeliveredRequest,
    ) => Promise<QueryDeliveredResponse>;
    /** RecipientIsm ... */
    readonly RecipientIsm: (
      req: RecipientIsmRequest,
    ) => Promise<RecipientIsmResponse>;
    /** VerifyDryRun ... */
    readonly VerifyDryRun: (
      req: QueryVerifyDryRunRequest,
    ) => Promise<QueryVerifyDryRunResponse>;
  };
}

export function setupCoreExtension(base: QueryClient): CoreExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new QueryClientImpl(rpc);
  return {
    core: {
      Mailboxes: (req: QueryMailboxesRequest) => queryService.Mailboxes(req),
      Mailbox: (req: QueryMailboxRequest) => queryService.Mailbox(req),
      Delivered: (req: QueryDeliveredRequest) => queryService.Delivered(req),
      RecipientIsm: (req: RecipientIsmRequest) =>
        queryService.RecipientIsm(req),
      VerifyDryRun: (req: QueryVerifyDryRunRequest) =>
        queryService.VerifyDryRun(req),
    },
  };
}
