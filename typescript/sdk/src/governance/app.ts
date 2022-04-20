import { GovernanceRouter } from '@abacus-network/apps';
import { ethers } from 'ethers';
import { AbacusApp } from '../app';
import { objMap, promiseObjAll } from '../utils';
import { GovernanceContracts } from './contracts';
import { GovernanceDeployedNetworks } from './environments';
import { associateCalls, Call, normalizeCall } from './utils';

export class AbacusGovernance extends AbacusApp<
  GovernanceDeployedNetworks,
  GovernanceContracts & { calls: Call[] }
> {
  routers = () =>
    objMap(this.domainMap, (d) => d.contracts.router as GovernanceRouter);

  governors = () =>
    promiseObjAll(objMap(this.routers(), (router) => router.governor()));

  getCalls(network: GovernanceDeployedNetworks) {
    return this.get(network).calls;
  }

  push(network: GovernanceDeployedNetworks, call: Call) {
    const normalized = normalizeCall(call);
    this.getCalls(network).push(normalized);
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
