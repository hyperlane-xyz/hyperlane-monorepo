import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { CoreConfig } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';

import { EvmCoreModule } from './EvmCoreModule.js';

describe('EvmCoreModule', async () => {
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
    it('should create deploy an ICA', () => {
      const { interchainAccountRouter, interchainAccountIsm } =
        evmCoreModule.serialize();
      expect(interchainAccountIsm).to.exist;
      expect(interchainAccountRouter).to.exist;
    });

    it('should deploy ISM factories', () => {
      // Each ISM factory
      objMap(
        evmCoreModule.serialize().ismFactoryFactories,
        (_: any, contract: any) => {
          expect(contract.address).to.exist;
        },
      );
    });

    it('should deploy proxyAdmin', () => {
      expect(evmCoreModule.serialize().proxyAdmin.address).to.exist;
    });

    it('should set proxyAdmin owner to deployer', async () => {
      expect(await evmCoreModule.serialize().proxyAdmin.owner()).to.equal(
        signer.address,
      );
    });

    it('should deploy mailbox', () => {
      expect(evmCoreModule.serialize().mailbox.address).to.exist;
    });

    it('should set mailbox owner to proxyAdmin', async () => {
      expect(await evmCoreModule.serialize().mailbox.owner()).to.equal(
        evmCoreModule.serialize().proxyAdmin.address,
      );
    });

    it('should deploy mailbox default Ism', async () => {
      const mailbox = evmCoreModule.serialize().mailbox;
      expect(await mailbox.defaultIsm()).to.not.equal(
        ethers.constants.AddressZero,
      );
    });

    it('should deploy mailbox default hook', async () => {
      const mailbox = evmCoreModule.serialize().mailbox;
      expect(await mailbox.defaultHook()).to.not.equal(
        ethers.constants.AddressZero,
      );
    });

    it('should deploy mailbox required hook', async () => {
      const mailbox = evmCoreModule.serialize().mailbox;
      expect(await mailbox.requiredHook()).to.not.equal(
        ethers.constants.AddressZero,
      );
    });

    it('should deploy validatorAnnounce', () => {
      expect(evmCoreModule.serialize().validatorAnnounce.address).to.exist;
    });

    it('should set validatorAnnounce owner to deployer', async () => {
      expect(
        await evmCoreModule.serialize().validatorAnnounce.owner(),
      ).to.equal(signer.address);
    });

    it('should deploy testRecipient', () => {
      expect(evmCoreModule.serialize().testRecipient.address).to.exist;
    });

    it('should set testRecipient owner to deployer', async () => {
      expect(await evmCoreModule.serialize().testRecipient.owner()).to.equal(
        signer.address,
      );
    });
  });
});
