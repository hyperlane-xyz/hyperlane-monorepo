import { KeypairWalletAdapter, type RouteExtended } from '@lifi/sdk';
import bs58 from 'bs58';
import { ethers } from 'ethers';
import { custom, isHex, type Transport } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import {
  TransactionSubmissionError,
  type TransactionSubmissionState,
  assert,
} from '@hyperlane-xyz/utils';

import type {
  BridgeExecutionOptions,
  PendingApproval,
} from '../interfaces/IExternalBridge.js';
import { Erc20ApprovalError } from './erc20Approve.js';

const approvalAbi = new ethers.utils.Interface([
  'function approve(address spender, uint256 amount)',
]);

/** Observe the SDK's source transport; its route hooks run after confirmation. */
export class LiFiSubmission {
  private state: TransactionSubmissionState = 'not_submitted';
  private approval?: PendingApproval;
  private confirmedApproval?: string;
  txHash?: string;

  constructor(private readonly options: BridgeExecutionOptions = {}) {}

  /** Only transactions broadcast through our observed transport may authorize a transfer. */
  evmAccount(key: string): PrivateKeyAccount {
    assert(isHex(key) && key.length === 66, 'Invalid LiFi EVM private key');
    const rejectAuthorization = async (): Promise<never> => {
      throw new Error('LiFi off-chain transfer authorization is unsupported');
    };
    return {
      ...privateKeyToAccount(key),
      signMessage: rejectAuthorization,
      signTypedData: rejectAuthorization,
      signAuthorization: rejectAuthorization,
    };
  }

  /** A completed SDK call without an observed identity cannot prove that nothing was sent. */
  requireSourceHash(): string {
    if (!this.txHash) {
      this.state = 'unknown';
      throw new Error(
        'No observed source transaction hash in executed LiFi route',
      );
    }
    return this.txHash;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (this.state === 'not_submitted' && this.approval) {
        throw new Erc20ApprovalError(
          error,
          'unknown',
          this.approval.txHash,
          this.approval.token,
          this.approval.spender,
        );
      }
      throw new TransactionSubmissionError(error, this.state, this.txHash);
    }
  }

  private async attempt(hash: string): Promise<void> {
    assert(
      !this.txHash || this.txHash === hash,
      'LiFi cannot submit a replacement or second source transaction',
    );
    await this.options.onSubmissionAttempt?.(hash);
    this.txHash = hash;
    this.state = 'unknown';
  }

  observeRoute(route: RouteExtended): void {
    const processes = route.steps[0]?.execution?.process ?? [];
    if (
      this.approval?.txHash &&
      processes.some(
        (process) =>
          process.type === 'TOKEN_ALLOWANCE' &&
          process.status === 'DONE' &&
          process.chainId === route.fromChainId &&
          process.txHash === this.approval?.txHash,
      )
    ) {
      this.confirmedApproval = this.approval.txHash;
    }
  }

  evmTransport(
    transport: Transport,
    chainId: number,
    token: string,
    spender: string | undefined,
    maxAmount: bigint,
  ): Transport {
    return (parameters) => {
      const base = transport(parameters);
      return custom(
        {
          request: async (request) => {
            if (request.method !== 'eth_sendRawTransaction') {
              assert(
                !request.method.startsWith('eth_send') &&
                  !request.method.startsWith('eth_sign') &&
                  !request.method.startsWith('wallet_send') &&
                  !request.method.startsWith('wallet_sign') &&
                  request.method !== 'personal_sign',
                `LiFi unobserved authorization method is unsupported: ${request.method}`,
              );
              return base.request(request);
            }
            if (
              this.approval?.txHash &&
              this.confirmedApproval === this.approval.txHash
            ) {
              await this.options.onApproval?.(undefined);
              this.approval = undefined;
              this.confirmedApproval = undefined;
            }
            const [raw] = request.params as [string];
            const tx = ethers.utils.parseTransaction(raw);
            assert(
              tx.chainId === chainId,
              'LiFi source transaction changed chain',
            );
            const hash = ethers.utils.keccak256(raw);
            if (tx.data.startsWith(approvalAbi.getSighash('approve'))) {
              const decoded = approvalAbi.decodeFunctionData(
                'approve',
                tx.data,
              );
              assert(
                tx.to?.toLowerCase() === token.toLowerCase() &&
                  spender?.toLowerCase() === decoded.spender.toLowerCase() &&
                  tx.value.isZero() &&
                  decoded.amount.toBigInt() <= maxAmount &&
                  approvalAbi.encodeFunctionData('approve', decoded) ===
                    tx.data,
                'LiFi approval differs from accepted source allowance',
              );
              assert(
                !this.txHash,
                'LiFi approval after source submission is unsupported',
              );
              assert(
                !this.approval || this.approval.txHash === hash,
                'LiFi previous approval has not been reconciled',
              );
              const approval = { txHash: hash, token, spender };
              await this.options.onApproval?.(approval);
              this.approval = approval;
              return base.request(request);
            }
            // LiFi waits for its approval receipt before submitting the source.
            await this.options.onApproval?.(undefined);
            this.approval = undefined;
            await this.attempt(hash);
            const result = await base.request(request);
            assert(
              String(result) === hash,
              'LiFi RPC returned a different transaction hash',
            );
            this.state = 'submitted';
            await this.options.onSubmitted?.(hash);
            return result;
          },
        },
        { retryCount: 0 },
      )(parameters);
    };
  }

  solanaWallet(key: string): KeypairWalletAdapter {
    const wallet = new KeypairWalletAdapter(key);
    const sign = wallet.signTransaction.bind(wallet);
    wallet.signTransaction = async (transaction) => {
      const signed = await sign(transaction);
      const signature =
        'version' in signed ? signed.signatures[0] : signed.signature;
      assert(signature, 'LiFi source transaction has no payer signature');
      // The SDK owns the subsequent simulation/RPC. Handing it signed bytes
      // exposes this identity even if it later hides the transport error.
      await this.attempt(bs58.encode(signature));
      return signed;
    };
    wallet.signAllTransactions = async (transactions) => {
      assert(
        transactions.length === 1,
        'LiFi multi-transaction Solana bundles are unsupported',
      );
      return [await wallet.signTransaction(transactions[0])];
    };
    return wallet;
  }
}
