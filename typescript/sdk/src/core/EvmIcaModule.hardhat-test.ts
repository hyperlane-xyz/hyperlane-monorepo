import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { IcaRouterConfig } from '../ica/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmIcaModule } from './EvmIcaModule.js';

describe('EvmIcaModule', async () => {
  const LOCAL_DOMAIN = 1;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let mailbox: Mailbox;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const Mailbox = new Mailbox__factory(signer);
    mailbox = await Mailbox.deploy(LOCAL_DOMAIN);
  });
  describe('Create', async () => {
    it('should deploy an ICA with ISM', async () => {
      const evmIcaModule = await EvmIcaModule.create({
        chain: TestChainName.test1,
        config: {
          mailbox: mailbox.address,
          owner: signer.address,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            urls: ['https://commitment-read-ism.hyperlane.xyz'],
            owner: signer.address,
          },
        },
        multiProvider,
      });

      const { interchainAccountRouter } = evmIcaModule.serialize();
      expect(interchainAccountRouter).to.not.equal(
        ethers.constants.AddressZero,
      );
    });

    it('should configure commitment ISM', async () => {
      const config: IcaRouterConfig = {
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          owner: signer.address,
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
        },
      };

      const evmIcaModule = await EvmIcaModule.create({
        chain: TestChainName.test1,
        config,
        multiProvider,
      });

      const actual = await evmIcaModule.read();
      expect(actual.commitmentIsm).to.deep.contain(config.commitmentIsm);
    });
  });
});
