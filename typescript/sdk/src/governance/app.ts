import { ethers } from 'ethers';

import { AbacusApp } from '../app';
import { domains } from '../domains';
import { ChainName } from '../types';

import { GovernanceContracts, GovernanceContractAddresses } from './contracts';
import { addresses } from './environments';
import { Call, normalizeCall, associateCalls } from './utils';

export type Governor = {
  domain: number;
  identifier: string;
};

export class AbacusGovernance extends AbacusApp<
  GovernanceContractAddresses,
  GovernanceContracts
> {
  readonly calls: Map<number, Readonly<Call>[]>;

  constructor(
    addressesOrEnv:
      | Partial<Record<ChainName, GovernanceContractAddresses>>
      | string,
  ) {
    super();
    let _addresses: Partial<Record<ChainName, GovernanceContractAddresses>> =
      {};
    if (typeof addressesOrEnv == 'string') {
      _addresses = addresses[addressesOrEnv];
      if (!_addresses)
        throw new Error(
          `addresses for environment ${addressesOrEnv} not found`,
        );
    } else {
      _addresses = addressesOrEnv;
    }
    const chains = Object.keys(_addresses) as ChainName[];
    chains.map((chain) => {
      this.registerDomain(domains[chain]);
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new GovernanceContracts(_addresses[chain]!));
    });
    this.calls = new Map();
  }

  /**
   * Returns the governors of this abacus deployment.
   *
   * @returns The governors of the deployment
   */
  async governors(): Promise<Governor[]> {
    const governorDomains = Array.from(this.contracts.keys());
    const governorAddresses = await Promise.all(
      governorDomains.map((domain) =>
        this.mustGetContracts(domain).router.governor(),
      ),
    );
    const governors: Governor[] = [];
    for (let i = 0; i < governorAddresses.length; i++) {
      if (governorAddresses[i] !== ethers.constants.AddressZero) {
        governors.push({
          identifier: governorAddresses[i],
          domain: governorDomains[i],
        });
      }
    }
    if (governors.length === 0) throw new Error('no governors');
    return governors;
  }

  /**
   * Returns the single governor of this deployment, throws an error if not found.
   *
   * @returns The governor of the deployment
   */
  async governor(): Promise<Governor> {
    const governors = await this.governors();
    if (governors.length !== 1) throw new Error('multiple governors');
    return governors[0];
  }

  get routerAddresses(): Record<number, string> {
    const addresses: Record<number, string> = {};
    for (const domain of this.domainNumbers) {
      addresses[domain] = this.mustGetContracts(domain).router.address;
    }
    return addresses;
  }

  push(domain: number, call: Call): void {
    const calls = this.calls.get(domain);
    const normalized = normalizeCall(call);
    if (!calls) {
      this.calls.set(domain, [normalized]);
    } else {
      calls.push(normalized);
    }
  }

  // Build governance transactions called by the governor at the specified
  // domain.
  async build(domain: number): Promise<ethers.PopulatedTransaction[]> {
    const [domains, calls] = associateCalls(this.calls);
    const router = this.mustGetContracts(domain).router;
    return Promise.all(
      domains.map((d: number, i: number) => {
        if (d === domain) {
          return router.populateTransaction.call(calls[i]);
        } else {
          return router.populateTransaction.callRemote(d, calls[i]);
        }
      }),
    );
  }

  // Sign each governance transaction and dispatch them to the chain
  async execute(
    domain: number,
  ): Promise<ethers.providers.TransactionReceipt[]> {
    const transactions = await this.build(domain);
    const signer = this.mustGetSigner(domain);
    const governor = await this.mustGetContracts(domain).router.governor();
    if ((await signer.getAddress()) !== governor)
      throw new Error('signer is not governor');
    const receipts = [];
    for (const tx of transactions) {
      const response = await signer.sendTransaction(tx);
      receipts.push(await response.wait(5));
    }
    return receipts;
  }

  async estimateGas(domain: number): Promise<ethers.BigNumber[]> {
    const transactions = await this.build(domain);
    const router = this.mustGetContracts(domain).router;
    const governor = await router.governor();
    const responses = [];
    for (const tx of transactions) {
      const txToEstimate = tx;
      // Estimate gas as the governor
      txToEstimate.from = governor;
      responses.push(
        await this.mustGetProvider(domain).estimateGas(txToEstimate),
      );
    }
    return responses;
  }
}
