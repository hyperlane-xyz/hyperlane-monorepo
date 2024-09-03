import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { CallData, isZeroishAddress } from '@hyperlane-xyz/utils';

import {
  createSafeTransaction,
  createSafeTransactionData,
  getSafeAndService,
  proposeSafeTransaction,
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
        gasLimit: estimate.mul(11).div(10), // 10% buffer
        ...call,
      });
      console.log(`confirmed tx ${receipt.transactionHash}`);
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
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
    public readonly safeAddress: string,
  ) {
    super();
  }

  async sendTransactions(calls: CallData[]) {
    const { safeSdk, safeService } = await getSafeAndService(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );

    if (isZeroishAddress(safeSdk.getMultiSendAddress())) {
      console.log(
        `MultiSend contract not deployed on ${this.chain}. Proposing transactions individually.`,
      );
      await this.proposeIndividualTransactions(calls, safeSdk, safeService);
    } else {
      await this.proposeMultiSendTransaction(calls, safeSdk, safeService);
    }
  }

  // Helper function to propose individual transactions
  private async proposeIndividualTransactions(
    calls: CallData[],
    safeSdk: any,
    safeService: any,
  ) {
    for (const call of calls) {
      const safeTransactionData = createSafeTransactionData(call);
      const safeTransaction = await createSafeTransaction(
        safeSdk,
        safeService,
        this.safeAddress,
        safeTransactionData,
      );
      await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
    }
  }

  // Helper function to propose a multi-send transaction
  private async proposeMultiSendTransaction(
    calls: CallData[],
    safeSdk: any,
    safeService: any,
  ) {
    const safeTransactionData = calls.map((call) =>
      createSafeTransactionData(call),
    );
    const safeTransaction = await createSafeTransaction(
      safeSdk,
      safeService,
      this.safeAddress,
      safeTransactionData,
    );
    await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: any,
    safeService: any,
    safeTransaction: any,
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
