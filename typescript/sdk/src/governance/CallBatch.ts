import { ethers } from 'ethers';

import { GovernanceContracts } from './app';
import { Call, normalizeCall, associateCalls } from './utils';

export class CallBatch {
  readonly calls: Map<number, Readonly<Call>[]>;
  private governance: GovernanceContracts;
  private domain: number;
  private built?: ethers.PopulatedTransaction[];

  constructor(domain: number, governance: GovernanceContracts) {
    this.governance = governance;
    this.domain = domain;
    this.calls = new Map();
  }

  static async fromContracts(domain: number, governance: GovernanceContracts): Promise<CallBatch> {
    const governor = await governance.router.governor();
    if (governor === ethers.constants.AddressZero)
      throw new Error(
        'Cannot create call batch on a chain without governance rights. Use the governing chain.',
      );
    return new CallBatch(domain, governance);
  }

  push(domain: number, call: Call): void {
    if (this.built)
      throw new Error('Batch has been built. Cannot push more calls');
    const calls = this.calls.get(domain);
    const normalized = normalizeCall(call);
    if (!calls) {
      this.calls.set(domain, [normalized]);
    } else {
      calls.push(normalized);
    }
  }

  // Build governance transactions from this callbatch
  async build(): Promise<ethers.PopulatedTransaction[]> {
    if (this.built) return this.built;
    const [domains, calls] = associateCalls(this.calls);
    this.built = await Promise.all(
      domains.map((domain: number, i: number) => {
        if (domain === this.domain) {
          return this.governance.router.populateTransaction.call(calls[i]);
        } else {
          return this.governance.router.populateTransaction.callRemote(
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
      receipts.push(await response.wait(5));
    }
    return receipts;
  }

  async estimateGas(): Promise<ethers.BigNumber[]> {
    const transactions = await this.build();
    const governor = await this.governance.router.governor();
    const responses = [];
    for (const tx of transactions) {
      const txToEstimate = tx;
      // Estimate gas as the governor
      txToEstimate.from = governor;
      responses.push(
        await this.governance.router.provider.estimateGas(txToEstimate),
      );
    }
    return responses;
  }

  async governorSigner(): Promise<ethers.Signer> {
    const signer = this.governance.router.signer;
    const governor = await this.governance.router.governor();
    const signerAddress = await signer.getAddress();
    if (signerAddress !== governor)
      throw new Error('Signer is not Governor');
    return signer;
  }
}
