import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants } from 'ethers';
import hre from 'hardhat';

import {
  Mailbox__factory,
  ProxyAdmin__factory,
  TestRecipient__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { testCoreConfig } from '../test/testUtils.js';

import { EvmCoreModule } from './EvmCoreModule.js';

describe('EvmCoreModule', async () => {
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let evmCoreModule: EvmCoreModule;
  let proxyAdminContract: any;
  let mailboxContract: any;
  let validatorAnnounceContract: any;
  let testRecipientContract: any;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const config = testCoreConfig([TestChainName.test1])[TestChainName.test1];

    evmCoreModule = await EvmCoreModule.create({
      chain: TestChainName.test1,
      config,
      multiProvider,
    });

    const { proxyAdmin, mailbox, validatorAnnounce, testRecipient } =
      evmCoreModule.serialize();
    proxyAdminContract = ProxyAdmin__factory.connect(
      proxyAdmin!,
      multiProvider.getProvider(TestChainName.test1),
    );

    mailboxContract = Mailbox__factory.connect(
      mailbox!,
      multiProvider.getProvider(TestChainName.test1),
    );

    validatorAnnounceContract = ValidatorAnnounce__factory.connect(
      validatorAnnounce!,
      multiProvider.getProvider(TestChainName.test1),
    );

    testRecipientContract = TestRecipient__factory.connect(
      testRecipient!,
      multiProvider.getProvider(TestChainName.test1),
    );
  });

  describe('Create', async () => {
    it('should create deploy an ICA', () => {
      console.log('evmCoreModule.serialize();', evmCoreModule.serialize());
      const { interchainAccountRouter, interchainAccountIsm } =
        evmCoreModule.serialize();
      expect(interchainAccountIsm).to.exist;
      expect(interchainAccountRouter).to.exist;
    });

    it('should deploy ISM factories', () => {
      // Each ISM factory
      objMap(
        evmCoreModule.serialize().deployedIsmFactoryFactories,
        (_: any, factoryAddress: any) => {
          expect(factoryAddress).to.exist;
          expect(factoryAddress).to.not.equal(constants.AddressZero);
        },
      );
    });

    it('should deploy proxyAdmin', () => {
      expect(evmCoreModule.serialize().proxyAdmin).to.exist;
    });

    it('should set proxyAdmin owner to deployer', async () => {
      expect(await proxyAdminContract.owner()).to.equal(signer.address);
    });

    it('should deploy mailbox', () => {
      expect(evmCoreModule.serialize().mailbox).to.exist;
    });

    it('should set mailbox owner to proxyAdmin', async () => {
      expect(await mailboxContract.owner()).to.equal(
        evmCoreModule.serialize().proxyAdmin,
      );
    });

    it('should deploy mailbox default Ism', async () => {
      expect(await mailboxContract.defaultIsm()).to.not.equal(
        constants.AddressZero,
      );
    });

    it('should deploy mailbox default hook', async () => {
      expect(await mailboxContract.defaultHook()).to.not.equal(
        constants.AddressZero,
      );
    });

    it('should deploy mailbox required hook', async () => {
      expect(await mailboxContract.requiredHook()).to.not.equal(
        constants.AddressZero,
      );
    });

    it('should deploy validatorAnnounce', () => {
      expect(evmCoreModule.serialize().validatorAnnounce).to.exist;
    });

    it('should set validatorAnnounce owner to deployer', async () => {
      expect(await validatorAnnounceContract.owner()).to.equal(signer.address);
    });

    it('should deploy testRecipient', () => {
      expect(evmCoreModule.serialize().testRecipient).to.exist;
    });

    it('should set testRecipient owner to deployer', async () => {
      expect(await testRecipientContract.owner()).to.equal(signer.address);
    });
  });
});
