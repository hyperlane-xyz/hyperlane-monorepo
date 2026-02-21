import { expect } from 'chai';
import hre from 'hardhat';
import { zeroAddress } from 'viem';

import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { IcaRouterConfig } from '../ica/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { getHardhatSigners } from '../test/hardhatViem.js';

import { EvmIcaModule } from './EvmIcaModule.js';

type SignerWithAddress = { address: string; [key: string]: any };

describe('EvmIcaModule', async () => {
  const LOCAL_DOMAIN = 1;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let mailbox: Mailbox;

  before(async () => {
    [signer] = await getHardhatSigners();
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
      expect(interchainAccountRouter).to.not.equal(zeroAddress);
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
      expect(actual.commitmentIsm.type).to.equal(config.commitmentIsm.type);
      expect(actual.commitmentIsm.urls).to.deep.equal(config.commitmentIsm.urls);
      expect(
        eqAddress(actual.commitmentIsm.owner, config.commitmentIsm.owner),
      ).to.equal(true);
    });
  });
});
