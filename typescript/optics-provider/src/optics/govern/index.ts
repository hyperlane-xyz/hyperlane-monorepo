import { ethers } from 'ethers';
import { CoreContracts } from '../contracts';
import fs from 'fs';
import path from 'path';


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

  constructor(core: CoreContracts, callerKnowsWhatTheyAreDoing: boolean) {
    if (!callerKnowsWhatTheyAreDoing) {
      throw new Error(
        'Please instantiate this class using the fromContext method',
      );
    }
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
    return new CallBatch(core, true);
  }

  pushLocal(call: Partial<Call>): void {
    if (this.built)
      throw new Error('Batch has been built. Cannot push more calls');
    this.local.push(utils.normalizeCall(call));
  }

  pushRemote(domain: number, call: Partial<Call>): void {
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
    if (this.built) return this.built;

    const [domains, remoteCalls] = utils.associateRemotes(this.remote);
    const local = await this.core.governanceRouter.populateTransaction.callLocal(this.local)
    const remotes = await Promise.all(
      domains.map((domain: number, i: number) => this.core.governanceRouter.populateTransaction.callRemote(domain, remoteCalls[i]))
    )
    this.built = remotes.concat(local)
    return this.built;
  }

  // Sign each governance transaction and dispatch them to the chain
  async execute(
    overrides?: ethers.Overrides,
  ): Promise<ethers.providers.TransactionResponse[]> {
    const transactions = await this.build(overrides);
    const signer = this.core.governanceRouter.signer;
    const governor = await this.core.governor()
    const signerAddress = await signer.getAddress()
    if (!governor.local)
      throw new Error('Governor is not local');
    if (signerAddress !== governor.identifier)
      throw new Error('Signer is not Governor');
    const responses = []
    for (const tx of transactions) {
      responses.push(await signer.sendTransaction(tx))
    }
    return responses
  }

  async call(
    overrides?: ethers.Overrides,
  ): Promise<any[]> {
    const transactions = await this.build(overrides);
    const signer = this.core.governanceRouter.signer;
    const governor = await this.core.governor()
    const signerAddress = await signer.getAddress()
    if (!governor.local)
      throw new Error('Governor is not local');
    if (signerAddress !== governor.identifier)
      throw new Error('Signer is not Governor');
    const responses = []
    for (const tx of transactions) {
      responses.push(await signer.estimateGas(tx))
    }
    return responses
  }

  write(directory: string) {
    if (!this.built)
      throw new Error('Must build batch before writing');
    const filename = `governance_${Date.now()}.json`;
    fs.writeFileSync(
      path.join(directory, filename),
      JSON.stringify(this.built, null, 2),
    );
  }
}
