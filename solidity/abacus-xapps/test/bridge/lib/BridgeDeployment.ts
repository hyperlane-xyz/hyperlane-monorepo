import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { assert } from 'chai';
import * as ethers from 'ethers';

import { AbacusDeployment } from '@abacus-network/abacus-sol/test/lib/AbacusDeployment';
import { utils, types } from '@abacus-network/utils';

import {
  MockWeth__factory,
  MockWeth,
  BridgeToken,
  BridgeToken__factory,
  BridgeRouter,
  BridgeRouter__factory,
  ETHHelper,
  ETHHelper__factory,
} from '../../../types';
import {
  UpgradeBeacon__factory,
  UpgradeBeacon,
} from '@abacus-network/abacus-sol/types';

export interface BridgeInstance {
  domain: types.Domain;
  router: BridgeRouter;
  helper: ETHHelper;
  beacon: UpgradeBeacon;
  token: BridgeToken;
  weth: MockWeth;
  signer: ethers.Signer;
}

export class BridgeDeployment {
  constructor(
    public readonly domains: types.Domain[],
    public readonly instances: Record<number, BridgeInstance>,
  ) {}

  static async fromAbacusDeployment(
    abacus: AbacusDeployment,
    signer: ethers.Signer,
  ) {
    const instances: Record<number, BridgeInstance> = {};
    for (const domain of abacus.domains) {
      const instance = await BridgeDeployment.deployInstance(
        domain,
        signer,
        abacus.instances[domain].connectionManager.address,
      );
      instances[domain] = instance;
    }

    for (const local of abacus.domains) {
      for (const remote of abacus.domains) {
        if (local !== remote) {
          await instances[local].router.enrollRemoteRouter(
            remote,
            utils.addressToBytes32(instances[remote].router.address),
          );
        }
      }
    }
    return new BridgeDeployment(abacus.domains, instances);
  }

  static async deployInstance(
    domain: types.Domain,
    signer: ethers.Signer,
    connectionManagerAddress: types.Address,
  ): Promise<BridgeInstance> {
    const wethFactory = new MockWeth__factory(signer);
    const weth = await wethFactory.deploy();
    await weth.initialize();

    const tokenFactory = new BridgeToken__factory(signer);
    const token = await tokenFactory.deploy();
    await token.initialize();

    const beaconFactory = new UpgradeBeacon__factory(signer);
    const beacon = await beaconFactory.deploy(
      token.address,
      await signer.getAddress(),
    );

    const routerFactory = new BridgeRouter__factory(signer);
    const router = await routerFactory.deploy();
    await router.initialize(beacon.address, connectionManagerAddress);

    const helperFactory = new ETHHelper__factory(signer);
    const helper = await helperFactory.deploy(weth.address, router.address);
    return {
      domain,
      beacon,
      router,
      helper,
      token,
      weth,
      signer,
    };
  }

  router(domain: types.Domain): BridgeRouter {
    return this.instances[domain].router;
  }

  signer(domain: types.Domain): ethers.Signer {
    return this.instances[domain].signer;
  }

  weth(domain: types.Domain): MockWeth {
    return this.instances[domain].weth;
  }

  helper(domain: types.Domain): ETHHelper {
    return this.instances[domain].helper;
  }

  async bridgeToken(
    local: types.Domain,
    remote: types.Domain,
    address: ethers.BytesLike,
  ): Promise<BridgeToken> {
    const router = this.router(local);
    const reprAddr = await router['getLocalAddress(uint32,bytes32)'](
      remote,
      address,
    );
    return BridgeToken__factory.connect(reprAddr, this.signer(local));
  }
}
