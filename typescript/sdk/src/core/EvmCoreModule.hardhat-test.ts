import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import { objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { CoreConfig } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';

import { EvmCoreModule } from './EvmCoreModule.js';

describe.only('EvmCoreModule', async () => {
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let evmCoreModule: EvmCoreModule;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    evmCoreModule = await EvmCoreModule.create({
      chain: TestChainName.test1,
      config: testCoreConfig([]) as CoreConfig,
      multiProvider,
    });
  });
  describe('Create', async () => {
    it('should create deploy an ICA', async () => {
      const { interchainAccountRouter, interchainAccountIsm } =
        evmCoreModule.serialize();
      expect(interchainAccountIsm).to.not.be.undefined;
      expect(interchainAccountRouter).to.not.be.undefined;
    });

    it('should return the correct addresses', async () => {
      // Each ISM factory
      objMap(evmCoreModule.serialize().ismFactories, (_, contract) => {
        expect(contract.address).to.be.not.undefined;
      });

      // proxyAdmin
      expect(evmCoreModule.serialize().proxyAdmin.address).to.be.not.undefined;

      // mailbox
      expect(evmCoreModule.serialize().mailbox.address).to.be.not.undefined;

      // validatorAnnounce
      expect(evmCoreModule.serialize().validatorAnnounce.address).to.be.not
        .undefined;
    });
  });
});
