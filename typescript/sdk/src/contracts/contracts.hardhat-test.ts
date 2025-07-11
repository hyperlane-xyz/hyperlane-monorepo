import { expect } from 'chai';
import { Contract, Signer, ethers } from 'ethers';
import hre from 'hardhat';

import { ERC20Test__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { isAddressActive } from './contracts.js';

describe('Contracts', () => {
  let signer: Signer;
  let contract: Contract;
  let multiProvider: MultiProvider;
  before(async () => {
    [signer] = await hre.ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const factory = new ERC20Test__factory(signer);
    contract = await factory.deploy(
      'fake',
      'FAKE',
      '100000000000000000000',
      18,
    );
    await contract.deployed();
  });
  describe('isAddressActive', async () => {
    it('should return false for AddressZero', async () => {
      const isActive = await isAddressActive(
        multiProvider.getProvider(TestChainName.test1),
        ethers.constants.AddressZero,
      );

      expect(isActive).to.be.false;
    });

    it('should return true for EOA address with some transactions', async () => {
      const active = await isAddressActive(
        multiProvider.getProvider(TestChainName.test1),
        await signer.getAddress(),
      );

      expect(active).to.be.true;
    });

    it('should return true for contracts address with a non-zero nonce', async () => {
      const active = await isAddressActive(
        multiProvider.getProvider(TestChainName.test1),
        contract.address,
      );

      expect(active).to.be.true;
    });
  });
});
