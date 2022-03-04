import {ethers } from 'ethers';
import { Address, Domain } from '../types';
import { Deploy } from '../deploy';

// TODO: Dedup
function addressToBytes32(address: Address): string {
  return ethers.utils
    .hexZeroPad(ethers.utils.hexStripZeros(address), 32)
    .toLowerCase();
}

interface Router {
  address: Address;
  enrollRemoteRouter(domain: Domain, router: Address): Promise<any>;
}

export abstract class RouterDeploy<T, V> extends Deploy<T, V> {
  async postDeploy(_: V) {
    // Make all routers aware of eachother.
    for (const local of this.domains) {
      for (const remote of this.domains) {
        await this.router(local).enrollRemoteRouter(
          remote,
          addressToBytes32(this.router(remote).address),
        );
      }
    }
  }

  abstract router(domain: Domain): Router;
}
