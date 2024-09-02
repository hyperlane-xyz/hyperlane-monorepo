import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
// @ts-ignore
import { getSafe, getSafeService } from '@hyperlane-xyz/sdk';
import { CallData, isZeroishAddress } from '@hyperlane-xyz/utils';

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
    const safeSdk = await getSafe(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );
    const safeService = getSafeService(this.chain, this.multiProvider);

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
      const safeTransactionData = this.createSafeTransactionData(call);
      const safeTransaction = await this.createSafeTransaction(
        safeSdk,
        safeService,
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
    const safeTransactionData = calls.map(this.createSafeTransactionData);
    const safeTransaction = await this.createSafeTransaction(
      safeSdk,
      safeService,
      safeTransactionData,
    );
    await this.proposeSafeTransaction(safeSdk, safeService, safeTransaction);
  }

  // Helper function to create safe transaction data
  private createSafeTransactionData(call: CallData) {
    return {
      to: call.to,
      data: call.data.toString(),
      value: call.value?.toString() || '0',
    };
  }

  // Helper function to create a safe transaction
  private async createSafeTransaction(
    safeSdk: any,
    safeService: any,
    safeTransactionData: any,
  ) {
    const nextNonce = await safeService.getNextNonce(this.safeAddress);
    return safeSdk.createTransaction({
      safeTransactionData,
      options: { nonce: nextNonce },
    });
  }

  // Helper function to propose a safe transaction
  private async proposeSafeTransaction(
    safeSdk: any,
    safeService: any,
    safeTransaction: any,
  ) {
    const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
    const senderSignature = await safeSdk.signTransactionHash(safeTxHash);
    const senderAddress = await this.multiProvider.getSignerAddress(this.chain);

    await safeService.proposeTransaction({
      safeAddress: this.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress,
      senderSignature: senderSignature.data,
    });

    console.log(`Proposed transaction with hash ${safeTxHash}`);
  }
}
