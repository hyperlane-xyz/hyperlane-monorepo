import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { SafeTransaction } from '@safe-global/safe-core-sdk-types';
import chalk from 'chalk';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  Address,
  CallData,
  addBufferToGasLimit,
  eqAddress,
} from '@hyperlane-xyz/utils';

import {
  createSafeTransaction,
  createSafeTransactionData,
  getSafeAndService,
  proposeSafeTransaction,
  retrySafeApi,
} from '../utils/safe.js';

export abstract class MultiSend {
  abstract sendTransactions(calls: CallData[]): Promise<void>;
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

  async sendTransactions(calls: CallData[]) {
    // If the multiSend address is the same as the safe address, we need to
    // propose the transactions individually. See: gnosisSafe.js in the SDK.
    if (eqAddress(this.safeSdk.getMultiSendAddress(), this.safeAddress)) {
      console.info(
        chalk.gray(
          `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
        ),
      );
      await this.proposeIndividualTransactions(calls);
    } else {
      await this.proposeMultiSendTransaction(calls);
    }
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(calls: CallData[]) {
    for (const call of calls) {
      const safeTransactionData = createSafeTransactionData(call);
      const safeTransaction = await createSafeTransaction(
        this.safeSdk,
        this.safeService,
        this.safeAddress,
        [safeTransactionData],
      );
      await this.proposeSafeTransaction(
        this.safeSdk,
        this.safeService,
        safeTransaction,
      );
    }
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(calls: CallData[]) {
    const safeTransactionData = calls.map((call) =>
      createSafeTransactionData(call),
    );
    const safeTransaction = await createSafeTransaction(
      this.safeSdk,
      this.safeService,
      this.safeAddress,
      safeTransactionData,
      true,
    );
    await this.proposeSafeTransaction(
      this.safeSdk,
      this.safeService,
      safeTransaction,
    );
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: Safe.default,
    safeService: SafeApiKit.default,
    safeTransaction: SafeTransaction,
  ) {
    const signer = this.multiProvider.getSigner(this.chain);
    await proposeSafeTransaction(
      this.chain,
      safeSdk,
      safeService,
      safeTransaction,
      this.safeAddress,
      signer,
    );
  }
}
