import Safe from '@gnosis.pm/safe-core-sdk';
import EthersAdapter from '@gnosis.pm/safe-ethers-lib';
import SafeServiceClient from '@gnosis.pm/safe-service-client';
import { ethers } from 'ethers';

import { ChainConnection, ChainName, chainMetadata } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

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
      if (false) {
        const receipt = await this.connection.sendTransaction(call);
        console.log(`confirmed tx ${receipt.transactionHash}`);
      }
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
    console.log(calls);
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
    const signer = this.connection.signer;
    if (!signer) throw new Error(`no signer found for ${this.chain}`);
    const ethAdapter = new EthersAdapter({ ethers, signer });
    const txServiceUrl =
      chainMetadata[this.chain].gnosisSafeTransactionServiceUrl;
    if (!txServiceUrl)
      throw new Error(`must provide tx service url for ${this.chain}`);
    const safeService = new SafeServiceClient({ txServiceUrl, ethAdapter });
    const safeSdk = await Safe.create({
      ethAdapter,
      safeAddress: this.safeAddress,
    });
    const transactions = calls.map((call) => {
      return { to: call.to, data: call.data.toString(), value: '0' };
    });
    const safeTransaction = await safeSdk.createTransaction(transactions);
    const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
    if (false) {
      const senderSignature = await safeSdk.signTransactionHash(safeTxHash);
      await safeService.proposeTransaction({
        safeAddress: this.safeAddress,
        safeTransactionData: safeTransaction.data,
        safeTxHash,
        senderAddress: await signer!.getAddress(),
        senderSignature: senderSignature.data,
      });
    }
  }
}
