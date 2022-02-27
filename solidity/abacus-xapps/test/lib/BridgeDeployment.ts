import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert } from 'chai';
import * as ethers from 'ethers';

import { AbacusDeployment } from './core';
import { toBytes32 } from './utils';
import * as types from './types';

import { MockWeth__factory, MockWeth, BridgeToken, BridgeToken__factory, BridgeRouter, BridgeRouter__factory, ETHHelper, ETHHelper__factory } from '../../typechain'

export interface BridgeInstance {
  domain: types.Domain;
  router: BridgeRouter;
  helper: ETHHelper;
  token: BridgeToken;
  weth: MockWeth;
}

export class BridgeDeployment {
  constructor(public readonly domains: types.Domain[], public readonly instances: Record<number, BridgeInstance>) {}

  static async fromAbacusDeployment(abacus: AbacusDeployment, signer: ethers.Signer) {
    const instances: Record<number, BridgeInstance> = {};
    for (const domain of abacus.domains) {
      const instance = await BridgeDeployment.deployInstance(domain, signer, abacus.instances[domain].connectionManager.address);
      instances[domain] = instance;
    }

    for (const local of abacus.domains) {
      for (const remote of abacus.domains) {
        if (local !== remote) {
          await instances[local].router.enrollRemoteRouter(remote, toBytes32(instances[remote].router.address))
        }
      }
    }
    return new BridgeDeployment(abacus.domains, instances);
  }

  static async deployInstance(domain: types.Domain, signer: ethers.Signer, connectionManagerAddress: types.Address): Promise<BridgeInstance> {
    const wethFactory = new MockWeth__factory(signer);
    const weth = await wethFactory.deploy();
    await weth.initialize();

    const tokenFactory = new BridgeToken__factory(signer);
    const token = await tokenFactory.deploy();
    await token.initialize();

    const routerFactory = new BridgeRouter__factory(signer);
    const router = await routerFactory.deploy();
    await router.initialize(token.address, connectionManagerAddress);

    const helperFactory = new ETHHelper__factory(signer);
    const helper = await helperFactory.deploy(weth.address, router.address);
    return {
      domain,
      router,
      helper,
      token,
      weth,
    }
  }
}
