import path from 'path';
import { ethers } from 'ethers';
import { utils, types } from '@abacus-network/utils';
import { Deploy, Instance } from '@abacus-network/abacus-deploy';

export enum DeployEnvironment {
  dev = 'dev',
  testnet = 'testnet',
  mainnet = 'mainnet',
  testnetLegacy = 'testnet-legacy',
  mainnetLegacy = 'mainnet-legacy',
  test = 'test',
}

export abstract class InfraDeploy<T extends Instance<any>, V> extends Deploy<T, V> {
  writeContracts(directory: string) {
    for (const domain of this.domains) {
      this.instances[domain].contracts.writeJson(
        path.join(directory, `${this.chains[domain].name}_contracts.json`),
      );
    }
  }

  async ready(): Promise<void> {
    await Promise.all(
      this.domains.map(
        (d) =>
          (this.chains[d].signer.provider! as ethers.providers.JsonRpcProvider)
            .ready,
      ),
    );
  }
}

interface Router {
  address: types.Address;
  enrollRemoteRouter(domain: types.Domain, router: types.Address): Promise<any>;
}

export abstract class InfraRouterDeploy<T extends Instance<any>, V> extends InfraDeploy<T, V> {
  // TODO(asa): Dedupe with abacus-deploy
  async postDeploy(_: V) {
    // Make all routers aware of eachother.
    for (const local of this.domains) {
      for (const remote of this.domains) {
        if (local === remote) continue;
        await this.router(local).enrollRemoteRouter(
          remote,
          utils.addressToBytes32(this.router(remote).address),
        );
      }
    }
  }

  abstract router(domain: types.Domain): Router;
}
