import { QueryClient } from '@cosmjs/stargate';

import {
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
export declare function setupCoreExtension(base: QueryClient): CoreExtension;
