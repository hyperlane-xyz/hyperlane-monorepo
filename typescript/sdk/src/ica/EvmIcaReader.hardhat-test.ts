import { expect } from 'chai';
import hre from 'hardhat';

import { Address } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { EvmCoreModule } from '../core/EvmCoreModule.js';
import { CoreConfig } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';

import { EvmIcaRouterReader } from './EvmIcaReader.js';

describe(EvmIcaRouterReader.name, async () => {
  const CHAIN = TestChainName.test4;
  let interchainAccountRouterAddress: Address;
  let interchainAccountRouterReader: EvmIcaRouterReader;
  let signerAddress: Address;

  before(async () => {
    const [signer] = await hre.ethers.getSigners();
    const multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const config: CoreConfig = {
      ...testCoreConfig([CHAIN])[CHAIN],
      owner: signer.address,
    };

    const addresses = await EvmCoreModule.deploy({
      chain: CHAIN,
      config,
      multiProvider,
    });

    signerAddress = signer.address;
    interchainAccountRouterAddress = addresses.interchainAccountRouter;
    interchainAccountRouterReader = new EvmIcaRouterReader(
      multiProvider,
      CHAIN,
    );
  });

  describe(EvmIcaRouterReader.prototype.deriveConfig.name, async () => {
    it('should read the ICA router config', async () => {
      const res = await interchainAccountRouterReader.deriveConfig(
        interchainAccountRouterAddress,
      );

      expect(res.address).to.equal(interchainAccountRouterAddress);
      expect(res.owner).to.equal(signerAddress);
      // Remote ICA Routers
      expect(res.remoteRouters).to.exist;
    });
  });
});
