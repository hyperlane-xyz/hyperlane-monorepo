import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransaction } from '@safe-global/types-kit';
import chalk from 'chalk';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  assert,
  eqAddress,
} from '@hyperlane-xyz/utils';

import {
  createSafeTransaction,
  createSafeTransactionData,
  getSafeAndService,
  isTypedDataSigner,
  proposeSafeTransaction,
  retrySafeApi,
} from '../utils/safe.js';

// Safe nonce overrides to ensure transactions are proposed at the correct nonce.
// Remove entries once the transactions have been executed.
export const SAFE_NONCE_OVERRIDES: Record<string, number> = {};

export abstract class MultiSend {
  abstract sendTransactions(calls: CallData[]): Promise<string[] | void>;
}

export class SignerMultiSend extends MultiSend {
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {
    super();
  }

  async sendTransactions(calls: CallData[]) {
    for (const call of calls) {
      const estimate = await this.multiProvider.estimateGas(this.chain, call);
      const receipt = await this.multiProvider.sendTransaction(this.chain, {
        gasLimit: addBufferToGasLimit(estimate),
        ...call,
      });
      console.log(chalk.green(`Confirmed tx ${receipt.transactionHash}`));
    }
  }
}

export class ManualMultiSend extends MultiSend {
  readonly chain: ChainName;

  constructor(chain: ChainName) {
    super();
    this.chain = chain;
  }

  async sendTransactions(calls: CallData[]) {
    console.log(`Please submit the following manually to ${this.chain}:`);
    console.log(JSON.stringify(calls));
  }
}

export class SafeMultiSend extends MultiSend {
  private constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly safeAddress: Address,
    private readonly safeSdk: Safe.default,
    private readonly safeService: SafeApiKit.default,
  ) {
    super();
  }

  public static async initialize(
    multiProvider: MultiProvider,
    chain: ChainName,
    safeAddress: Address,
  ) {
    const { safeSdk, safeService } = await retrySafeApi(() =>
      getSafeAndService(chain, multiProvider, safeAddress),
    );
    return new SafeMultiSend(
      multiProvider,
      chain,
      safeAddress,
      safeSdk,
      safeService,
    );
  }

  async sendTransactions(calls: CallData[]): Promise<string[]> {
    // If the multiSend address is the same as the safe address, we need to
    // propose the transactions individually. See: gnosisSafe.js in the SDK.
    if (eqAddress(this.safeSdk.getMultiSendAddress(), this.safeAddress)) {
      console.info(
        chalk.gray(
          `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
        ),
      );
      return this.proposeIndividualTransactions(calls);
    } else {
      return this.proposeMultiSendTransaction(calls);
    }
  }

  // Resolve the base nonce for new proposals: a manual override if set,
  // otherwise the Safe transaction service's next nonce (queue-aware: highest
  // pending + 1). Falling back to protocol-kit's default would use the on-chain
  // nonce and collide with an already-pending proposal at that nonce.
  private async resolveBaseNonce(): Promise<number> {
    const override = SAFE_NONCE_OVERRIDES[this.chain];
    if (override !== undefined) {
      return override;
    }
    const nextNonce = await retrySafeApi(() =>
      this.safeService.getNextNonce(this.safeAddress),
    );
    return parseInt(nextNonce, 10);
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(
    calls: CallData[],
  ): Promise<string[]> {
    const baseNonce = await this.resolveBaseNonce();
    const hashes: string[] = [];
    for (const [i, call] of calls.entries()) {
      const safeTransactionData = createSafeTransactionData(call);
      const safeTransaction = await createSafeTransaction(
        this.safeSdk,
        [safeTransactionData],
        undefined,
        baseNonce + i,
      );
      hashes.push(
        await this.proposeSafeTransaction(
          this.safeSdk,
          this.safeService,
          safeTransaction,
        ),
      );
    }
    return hashes;
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(
    calls: CallData[],
  ): Promise<string[]> {
    const nonce = await this.resolveBaseNonce();
    const safeTransactionData = calls.map((call) =>
      createSafeTransactionData(call),
    );
    const safeTransaction = await createSafeTransaction(
      this.safeSdk,
      safeTransactionData,
      true,
      nonce,
    );
    const hash = await this.proposeSafeTransaction(
      this.safeSdk,
      this.safeService,
      safeTransaction,
    );
    return [hash];
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
    safeTransaction: SafeTransaction,
  ): Promise<string> {
    const signer = this.multiProvider.getSigner(this.chain);
    assert(
      isTypedDataSigner(signer),
      `Signer for chain ${this.chain} does not support EIP-712 typed-data signing`,
    );
    return proposeSafeTransaction(
      this.chain,
      safeSdk,
      safeService,
      safeTransaction,
      this.safeAddress,
      signer,
    );
  }
}
