import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { TestAbacusDeploy, TestRouterDeploy } from '@abacus-network/hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  MockWeth__factory,
  MockWeth,
  BridgeToken,
  BridgeToken__factory,
  BridgeRouter,
  BridgeRouter__factory,
  ETHHelper,
  ETHHelper__factory,
} from '../../../typechain';
import {
  UpgradeBeacon__factory,
  UpgradeBeacon,
} from '@abacus-network/abacus-sol/typechain';

export type BridgeConfig = SignerWithAddress;

export interface BridgeInstance {
  router: BridgeRouter;
  helper: ETHHelper;
  beacon: UpgradeBeacon;
  token: BridgeToken;
  weth: MockWeth;
}

export class BridgeDeploy extends TestRouterDeploy<BridgeInstance, BridgeConfig> {
  async deployInstance(
    domain: types.Domain,
    abacus: TestAbacusDeploy,
  ): Promise<BridgeInstance> {
    const wethFactory = new MockWeth__factory(this.signer);
    const weth = await wethFactory.deploy();
    await weth.initialize();

    const tokenFactory = new BridgeToken__factory(this.signer);
    const token = await tokenFactory.deploy();
    await token.initialize();

    const beaconFactory = new UpgradeBeacon__factory(this.signer);
    const beacon = await beaconFactory.deploy(
      token.address,
      this.signer.address,
    );

    const routerFactory = new BridgeRouter__factory(this.signer);
    const router = await routerFactory.deploy();
    await router.initialize(beacon.address, abacus.xAppConnectionManager(domain).address);

    const helperFactory = new ETHHelper__factory(this.signer);
    const helper = await helperFactory.deploy(weth.address, router.address);
    return {
      beacon,
      router,
      helper,
      token,
      weth,
    };
  }

  get signer(): SignerWithAddress {
    return this.config;
  }

  router(domain: types.Domain): BridgeRouter {
    return this.instances[domain].router;
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
    return BridgeToken__factory.connect(reprAddr, this.signer)
  }
}
