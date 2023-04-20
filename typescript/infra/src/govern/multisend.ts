import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { getSafe, getSafeService } from '../utils/safe';

export abstract class MultiSend {
  abstract sendTransactions(calls: types.CallData[]): Promise<void>;
}

export class SignerMultiSend extends MultiSend {
  constructor(
    public readonly multiProvider: MultiProvider,
    public readonly chain: ChainName,
  ) {
    super();
  }

  async sendTransactions(calls: types.CallData[]) {
    for (const call of calls) {
      const receipt = await this.multiProvider.sendTransaction(
        this.chain,
        call,
      );
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

  async sendTransactions(calls: types.CallData[]) {
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

  async sendTransactions(calls: types.CallData[]) {
    const safeSdk = await getSafe(
      this.chain,
      this.multiProvider,
      this.safeAddress,
    );
    const safeService = getSafeService(this.chain, this.multiProvider);

    const safeTransactionData = calls.map((call) => {
      return { to: call.to, data: call.data.toString(), value: '0' };
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
