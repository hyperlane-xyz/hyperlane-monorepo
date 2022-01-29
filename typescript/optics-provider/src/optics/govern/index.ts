import { ethers } from 'ethers';
import { CoreContracts } from '../contracts';

import * as utils from './utils';

export type Address = string;

export interface Call {
  to: Address;
  data: ethers.utils.BytesLike;
}

export class CallBatch {
  readonly calls: Map<number, Readonly<Call>[]>;
  private core: CoreContracts;
  private built?: ethers.PopulatedTransaction[];

  constructor(core: CoreContracts) {
    this.core = core;
    this.calls = new Map();
  }

  static async fromCore(core: CoreContracts): Promise<CallBatch> {
    const governor = await core.governor();
    if (!governor.local)
      throw new Error(
        'Cannot create call batch on a chain without governance rights. Use the governing chain.',
      );
    return new CallBatch(core);
  }

  push(domain: number, call: Call): void {
    if (this.built)
      throw new Error('Batch has been built. Cannot push more calls');
    const calls = this.calls.get(domain);
    const normalized = utils.normalizeCall(call);
    if (!calls) {
      this.calls.set(domain, [normalized]);
    } else {
      calls.push(normalized);
    }
  }

  // Build governance transactions from this callbatch
  async build(): Promise<ethers.PopulatedTransaction[]> {
    if (this.built) return this.built;
    const [domains, calls] = utils.associateCalls(this.calls);
    this.built = await Promise.all(
      domains.map((domain: number, i: number) => {
        if (domain === this.core.domain) {
          return this.core.governanceRouter.populateTransaction.callLocal(
            calls[i],
          );
        } else {
          return this.core.governanceRouter.populateTransaction.callRemote(
            domain,
            calls[i],
          );
        }
      }),
    );
    return this.built;
  }

  // Sign each governance transaction and dispatch them to the chain
  async execute(): Promise<ethers.providers.TransactionReceipt[]> {
    const transactions = await this.build();
    const signer = await this.governorSigner();
    const receipts = [];
    for (const tx of transactions) {
      const response = await signer.sendTransaction(tx);
      receipts.push(await response.wait());
    }
    return receipts;
  }

  async estimateGas(): Promise<any[]> {
    const transactions = await this.build();
    const signer = await this.governorSigner();
    const responses = [];
    for (const tx of transactions) {
      responses.push(await signer.estimateGas(tx));
    }
    return responses;
  }

  async governorSigner(): Promise<ethers.Signer> {
    const signer = this.core.governanceRouter.signer;
    const governor = await this.core.governor();
    const signerAddress = await signer.getAddress();
    if (!governor.local) throw new Error('Governor is not local');
    if (signerAddress !== governor.identifier)
      throw new Error('Signer is not Governor');
    return signer;
  }
}
