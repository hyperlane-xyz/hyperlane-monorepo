import { ChainConnection, ChainName } from '@hyperlane-xyz/sdk';
import { types } from '@hyperlane-xyz/utils';

import { getSafe, getSafeService } from '../utils/safe';

export abstract class MultiSend {
  abstract sendTransactions(calls: types.CallData[]): Promise<void>;
}

export class SignerMultiSend extends MultiSend {
  readonly connection: ChainConnection;

  constructor(connection: ChainConnection) {
    super();
    this.connection = connection;
  }

  async sendTransactions(calls: types.CallData[]) {
    for (const call of calls) {
      const receipt = await this.connection.sendTransaction(call);
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
  readonly connection: ChainConnection;
  readonly chain: ChainName;
  readonly safeAddress: string;

  constructor(
    connection: ChainConnection,
    chain: ChainName,
    safeAddress: string,
  ) {
    super();
    this.connection = connection;
    this.chain = chain;
    this.safeAddress = safeAddress;
  }

  async sendTransactions(calls: types.CallData[]) {
    const safeSdk = await getSafe(this.connection, this.safeAddress);
    const safeTransactionData = calls.map((call) => {
      return { to: call.to, data: call.data.toString(), value: '0' };
    });
    const safeTransaction = await safeSdk.createTransaction({
      safeTransactionData,
    });
    const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
    const senderSignature = await safeSdk.signTransactionHash(safeTxHash);

    const safeService = getSafeService(this.chain, this.connection);
    if (!this.connection.signer) throw new Error('missing signer');
    await safeService.proposeTransaction({
      safeAddress: this.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: await this.connection.signer.getAddress()!,
      senderSignature: senderSignature.data,
    });
  }
}
