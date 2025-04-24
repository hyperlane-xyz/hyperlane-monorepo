import { QueryClient } from '@cosmjs/stargate';

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
export declare function setupCoreExtension(base: QueryClient): CoreExtension;
//# sourceMappingURL=query.d.ts.map
