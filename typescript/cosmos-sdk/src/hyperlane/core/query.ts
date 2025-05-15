import { QueryClient, createProtobufRpcClient } from '@cosmjs/stargate';

import { coreQuery } from '@hyperlane-xyz/cosmos-types';

export interface CoreExtension {
  readonly core: {
    /** Mailboxes ... */
    readonly Mailboxes: (
      req: coreQuery.QueryMailboxesRequest,
    ) => Promise<coreQuery.QueryMailboxesResponse>;
    /** Mailbox ... */
    readonly Mailbox: (
      req: coreQuery.QueryMailboxRequest,
    ) => Promise<coreQuery.QueryMailboxResponse>;
    /** Delivered ... */
    readonly Delivered: (
      req: coreQuery.QueryDeliveredRequest,
    ) => Promise<coreQuery.QueryDeliveredResponse>;
    /** RecipientIsm ... */
    readonly RecipientIsm: (
      req: coreQuery.QueryRecipientIsmRequest,
    ) => Promise<coreQuery.QueryRecipientIsmResponse>;
    /** VerifyDryRun ... */
    readonly VerifyDryRun: (
      req: coreQuery.QueryVerifyDryRunRequest,
    ) => Promise<coreQuery.QueryVerifyDryRunResponse>;
  };
}

export function setupCoreExtension(base: QueryClient): CoreExtension {
  const rpc = createProtobufRpcClient(base);
  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification

  const queryService = new coreQuery.QueryClientImpl(rpc);
  return {
    core: {
      Mailboxes: (req: coreQuery.QueryMailboxesRequest) =>
        queryService.Mailboxes(req),
      Mailbox: (req: coreQuery.QueryMailboxRequest) =>
        queryService.Mailbox(req),
      Delivered: (req: coreQuery.QueryDeliveredRequest) =>
        queryService.Delivered(req),
      RecipientIsm: (req: coreQuery.QueryRecipientIsmRequest) =>
        queryService.RecipientIsm(req),
      VerifyDryRun: (req: coreQuery.QueryVerifyDryRunRequest) =>
        queryService.VerifyDryRun(req),
    },
  };
}
