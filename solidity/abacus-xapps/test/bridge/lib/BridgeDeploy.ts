import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { types as deployTypes } from '@abacus-network/abacus-deploy';
import { RouterDeploy } from '@abacus-network/abacus-deploy/src/router/RouterDeploy';
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

export type BridgeConfig = {
  signer: SignerWithAddress;
  connectionManager: Record<types.Domain, types.Address>;
};

export interface BridgeInstance {
  router: BridgeRouter;
  helper: ETHHelper;
  beacon: UpgradeBeacon;
  token: BridgeToken;
  weth: MockWeth;
}

export class BridgeDeploy extends RouterDeploy<BridgeInstance, BridgeConfig> {
  async deployInstance(
    chain: deployTypes.ChainConfig,
    config: BridgeConfig,
  ): Promise<BridgeInstance> {
    const wethFactory = new MockWeth__factory(chain.signer);
    const weth = await wethFactory.deploy();
    await weth.initialize();

    const tokenFactory = new BridgeToken__factory(chain.signer);
    const token = await tokenFactory.deploy();
    await token.initialize();

    const beaconFactory = new UpgradeBeacon__factory(chain.signer);
    const beacon = await beaconFactory.deploy(
      token.address,
      await chain.signer.getAddress(),
    );

    const routerFactory = new BridgeRouter__factory(chain.signer);
    const router = await routerFactory.deploy();
    await router.initialize(
      beacon.address,
      config.connectionManager[chain.domain],
    );

    const helperFactory = new ETHHelper__factory(chain.signer);
    const helper = await helperFactory.deploy(weth.address, router.address);
    return {
      beacon,
      router,
      helper,
      token,
      weth,
    };
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
    return BridgeToken__factory.connect(reprAddr, this.chains[local].signer);
  }
}
