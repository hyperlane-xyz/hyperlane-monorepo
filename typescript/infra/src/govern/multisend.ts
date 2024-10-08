import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
// @ts-ignore
import { getSafe, getSafeService } from '@hyperlane-xyz/sdk';
import { CallData } from '@hyperlane-xyz/utils';

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

    const safeTransactionData = calls.map((call) => {
      return {
        to: call.to,
        data: call.data.toString(),
        value: call.value?.toString() || '0',
      };
    });
    const nextNonce = await safeService.getNextNonce(this.safeAddress);
    const safeTransaction = await safeSdk.createTransaction({
      safeTransactionData,
      options: { nonce: nextNonce },
    });
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
  }
}
