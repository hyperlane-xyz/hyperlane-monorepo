import type { SafeTransactionData } from '@safe-global/types-kit';
import { constants } from 'ethers';
import { z } from 'zod';

import {
  Address,
  assert,
  eqAddressEvm,
  isAddressEvm,
} from '@hyperlane-xyz/utils';

const PAGE_SIZE = 100;
const MULTISIG_TRANSACTIONS = 'multisig-transactions';
const QUEUE = `${MULTISIG_TRANSACTIONS}/queue`;
const DecimalString = z.string().regex(/^\d+$/);
const TransactionHash = z.string().regex(/^0x[\da-f]{64}$/i);
const SafeAddress = z.string().refine(isAddressEvm);
const AddressOrZero = SafeAddress.nullable().transform(
  (address) => address ?? constants.AddressZero,
);

const ProposalSchema = z.object({ safeTxHash: TransactionHash });
const TransactionSchema = ProposalSchema.extend({
  safe: SafeAddress,
  chainId: DecimalString,
  nonce: DecimalString,
  to: AddressOrZero,
  value: DecimalString,
  data: z
    .string()
    .nullable()
    .transform((data) => data ?? '0x'),
  operation: z.int(),
  safeTxGas: DecimalString,
  baseGas: DecimalString,
  gasPrice: DecimalString,
  gasToken: AddressOrZero,
  refundReceiver: AddressOrZero,
  txHash: TransactionHash.nullable(),
  created: z.string(),
  proposer: SafeAddress.nullable(),
  proposedBy: SafeAddress.nullable(),
  proposedVia: z.enum(['OWNER', 'DELEGATE', 'NESTED_OWNER', 'UNKNOWN']),
  confirmations: z.array(
    z.object({
      owner: SafeAddress,
      signature: z.string(),
      signatureType: z.string(),
      created: z.string(),
    }),
  ),
});

const DelegationSchema = z.object({
  delegate: SafeAddress,
  delegator: SafeAddress,
  safe: SafeAddress.nullable(),
  chainId: DecimalString.nullable(),
});

export type SafeQueueTransaction = z.infer<typeof TransactionSchema>;

type QueueProposal = {
  safeAddress: Address;
  safeTransactionData: SafeTransactionData;
  safeTxHash: string;
  senderAddress: Address;
  senderSignature: string;
};

export class SafeQueueServiceError extends Error {
  readonly isRecoverable: boolean;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Safe Queue Service returned ${status}: ${message}`);
    this.isRecoverable = status === 429 || status >= 500;
  }
}

export class SafeQueueService {
  private readonly baseUrl: URL;
  private readonly headers: Headers;

  constructor(
    gatewayOrigin: string,
    private readonly chainId: number,
    apiKey?: string,
  ) {
    this.baseUrl = new URL('/queue/api/v1/', gatewayOrigin);
    this.headers = new Headers();
    if (apiKey) this.headers.set('Authorization', `Bearer ${apiKey}`);
  }

  async getPendingTransactions(
    safeAddress: Address,
    options?: { includeStale?: boolean },
  ): Promise<SafeQueueTransaction[]> {
    const transactions = options?.includeStale
      ? await this.getAllPages(
          `safes/${SafeAddress.parse(safeAddress)}/${MULTISIG_TRANSACTIONS}`,
          { chainId: String(this.chainId), executed: 'false' },
          TransactionSchema,
        )
      : await this.getAllPages(
          QUEUE,
          { safes: `${safeAddress}:${this.chainId}` },
          TransactionSchema,
        );
    for (const transaction of transactions) {
      this.assertScope(transaction, safeAddress);
    }
    return transactions;
  }

  async getNextNonce(
    safeAddress: Address,
    getCurrentNonce: () => Promise<string | number>,
  ): Promise<string> {
    const {
      results: [highest],
    } = await this.getPage(
      QUEUE,
      {
        safes: `${safeAddress}:${this.chainId}`,
        nonceOrder: 'desc',
        limit: '1',
      },
      TransactionSchema,
    );
    if (!highest) return String(await getCurrentNonce());
    this.assertScope(highest, safeAddress);
    return (BigInt(highest.nonce) + 1n).toString();
  }

  async getTransaction(
    safeTxHash: string,
  ): Promise<SafeQueueTransaction | undefined> {
    try {
      const response = await this.request(this.transactionPath(safeTxHash));
      const transaction = TransactionSchema.parse(await response.json());
      this.assertScope(transaction);
      assert(
        transaction.safeTxHash.toLowerCase() === safeTxHash.toLowerCase(),
        `Safe Queue Service returned a different hash for ${safeTxHash}`,
      );
      return transaction;
    } catch (error) {
      if (error instanceof SafeQueueServiceError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async proposeTransaction({
    safeAddress,
    safeTransactionData,
    safeTxHash,
    senderAddress,
    senderSignature,
  }: QueueProposal): Promise<void> {
    try {
      const response = await this.request(MULTISIG_TRANSACTIONS, {
        method: 'POST',
        body: {
          ...safeTransactionData,
          chainId: this.chainId,
          safe: safeAddress,
          signatures: [senderSignature],
        },
      });
      const proposal = ProposalSchema.parse(await response.json());
      assert(
        proposal.safeTxHash.toLowerCase() === safeTxHash.toLowerCase(),
        `Safe Queue Service returned ${proposal.safeTxHash} for proposal ${safeTxHash}`,
      );
    } catch (error) {
      if (!(error instanceof SafeQueueServiceError) || error.status !== 409) {
        throw error;
      }
      const existing = await this.getTransaction(safeTxHash);
      if (!existing) throw error;
      this.assertScope(existing, safeAddress);
      const alreadySigned = existing.confirmations.some(({ owner }) =>
        eqAddressEvm(owner, senderAddress),
      );
      // Delegate and nested-owner proposals record the submitter without a confirmation.
      const alreadyProposed =
        existing.proposedBy !== null &&
        eqAddressEvm(existing.proposedBy, senderAddress);
      if (alreadySigned || alreadyProposed) return;

      // The legacy proposal endpoint stored new owner signatures on repeat POSTs.
      // Queue rejects repeat proposals and collects confirmations separately.
      try {
        await this.request(`${this.transactionPath(safeTxHash)}/signatures`, {
          method: 'POST',
          body: { signatures: [senderSignature] },
        });
      } catch (signatureError) {
        if (
          !(signatureError instanceof SafeQueueServiceError) ||
          signatureError.status !== 409
        ) {
          throw signatureError;
        }
      }
    }
  }

  async deleteTransaction(
    safeTxHash: string,
    signature: string,
  ): Promise<void> {
    try {
      await this.request(this.transactionPath(safeTxHash), {
        method: 'DELETE',
        body: { signature },
      });
    } catch (error) {
      if (!(error instanceof SafeQueueServiceError) || error.status !== 404) {
        throw error;
      }
    }
  }

  async isDelegate(
    proposer: Address,
    safeAddress: Address,
    owners: Address[],
  ): Promise<boolean> {
    // Filtering by safe or chain would exclude delegations with a global scope.
    const delegations = await this.getAllPages(
      'delegates',
      { delegate: proposer },
      DelegationSchema,
    );
    return delegations.some(
      ({ chainId, safe, delegate, delegator }) =>
        (chainId === null || chainId === String(this.chainId)) &&
        (safe === null || eqAddressEvm(safe, safeAddress)) &&
        eqAddressEvm(delegate, proposer) &&
        owners.some((owner) => eqAddressEvm(owner, delegator)),
    );
  }

  private transactionPath(safeTxHash: string): string {
    return `${MULTISIG_TRANSACTIONS}/${TransactionHash.parse(safeTxHash)}`;
  }

  private assertScope(
    transaction: SafeQueueTransaction,
    safeAddress?: Address,
  ) {
    assert(
      transaction.chainId === String(this.chainId) &&
        (!safeAddress || eqAddressEvm(transaction.safe, safeAddress)),
      `Safe Queue Service returned ${transaction.safeTxHash} outside the requested Safe or chain`,
    );
  }

  private async getAllPages<T>(
    path: string,
    query: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const results: T[] = [];
    for (;;) {
      const page = await this.getPage(
        path,
        { ...query, limit: String(PAGE_SIZE), offset: String(results.length) },
        schema,
      );
      results.push(...page.results);
      if (!page.next) return results;
      assert(
        page.results.length > 0,
        'Safe Queue Service returned an empty page with a next page',
      );
    }
  }

  private async getPage<T>(
    path: string,
    query: Record<string, string>,
    schema: z.ZodType<T>,
  ) {
    const response = await this.request(
      `${path}?${new URLSearchParams(query)}`,
    );
    return z
      .object({ results: z.array(schema), next: z.string().nullable() })
      .parse(await response.json());
  }

  private async request(
    path: string,
    options?: { method: 'POST' | 'DELETE'; body: unknown },
  ): Promise<Response> {
    const headers = new Headers(this.headers);
    if (options) headers.set('Content-Type', 'application/json');
    const url = new URL(path, this.baseUrl);
    const method = options?.method ?? 'GET';
    const response = await fetch(url, {
      method,
      headers,
      body: options && JSON.stringify(options.body),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new SafeQueueServiceError(
        response.status,
        `${method} ${url.pathname} ${response.statusText}`.trimEnd(),
      );
    }
    return response;
  }
}
