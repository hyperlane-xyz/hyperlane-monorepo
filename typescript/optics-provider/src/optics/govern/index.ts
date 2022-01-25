import { ethers } from 'ethers';
import { CoreContracts } from '../contracts';


import * as utils from './utils';

export type Address = string;

export interface Call {
  to: Address;
  data: ethers.utils.BytesLike;
}

export class CallBatch {
  readonly local: Readonly<Call>[];
  readonly remote: Map<number, Readonly<Call>[]>;
  private core: CoreContracts;
  private built?: ethers.PopulatedTransaction[];

  constructor(core: CoreContracts) {
    this.core = core;
    this.remote = new Map();
    this.local = [];
  }

  static async fromCore(core: CoreContracts): Promise<CallBatch> {
    const governor = await core.governor();
    if (!governor.local)
      throw new Error(
        'Cannot create call batch on a chain without governance rights. Use the governing chain.',
      );
    return new CallBatch(core);
  }

  pushLocal(call: Call): void {
    if (this.built)
      throw new Error('Batch has been built. Cannot push more calls');
    this.local.push(utils.normalizeCall(call));
  }

  pushRemote(domain: number, call: Call): void {
    if (this.built)
      throw new Error('Batch has been built. Cannot push more calls');
    const calls = this.remote.get(domain);
    const normalized = utils.normalizeCall(call);
    if (!calls) {
      this.remote.set(domain, [normalized]);
    } else {
      calls.push(normalized);
    }
  }

  // Build governance transactions from this callbatch
  async build(
    overrides?: ethers.Overrides,
  ): Promise<ethers.PopulatedTransaction[]> {
    if (this.built && overrides)
      throw new Error('Cannot rebuild batch with new overrides')
    if (this.built) return this.built;
    const [domains, remoteCalls] = utils.associateRemotes(this.remote);
    const local = await this.core.governanceRouter.populateTransaction.callLocal(this.local)
    const remotes = await Promise.all(
      domains.map((domain: number, i: number) => this.core.governanceRouter.populateTransaction.callRemote(domain, remoteCalls[i], overrides))
    )
    this.built = remotes.concat(local)
    return this.built;
  }

  // Sign each governance transaction and dispatch them to the chain
  async execute(
    overrides?: ethers.Overrides,
  ): Promise<ethers.providers.TransactionReceipt[]> {
    const transactions = await this.build(overrides);
    const signer = await this.governorSigner()
    const receipts = []
    for (const tx of transactions) {
      const response = await signer.sendTransaction(tx)
      receipts.push(await response.wait())
    }
    return receipts
  }

  async estimateGas(
    overrides?: ethers.Overrides,
  ): Promise<any[]> {
    const transactions = await this.build(overrides);
    const signer = await this.governorSigner()
    const responses = []
    for (const tx of transactions) {
      responses.push(await signer.estimateGas(tx))
    }
    return responses
  }

  async governorSigner(): Promise<ethers.Signer> {
    const signer = this.core.governanceRouter.signer;
    const governor = await this.core.governor()
    const signerAddress = await signer.getAddress()
    if (!governor.local)
      throw new Error('Governor is not local');
    if (signerAddress !== governor.identifier)
      throw new Error('Signer is not Governor');
    return signer
  }
}
