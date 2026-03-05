import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  IERC20__factory,
  Mailbox,
  Mailbox__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { FeeTokenApproval, IcaRouterConfig } from '../ica/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

import { EvmIcaModule } from './EvmIcaModule.js';

describe('EvmIcaModule', async () => {
  // test4 has chainId 31337 which matches hardhat's default
  const chain = TestChainName.test4;
  const LOCAL_DOMAIN = 31337;
  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let mailbox: Mailbox;
  let erc20Factory: ERC20Test__factory;
  let feeToken: ERC20Test;
  let feeToken2: ERC20Test;

  async function sendTxs(txs: AnnotatedEV5Transaction[]) {
    for (const tx of txs) {
      await multiProvider.sendTransaction(chain, tx);
    }
  }

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const Mailbox = new Mailbox__factory(signer);
    mailbox = await Mailbox.deploy(LOCAL_DOMAIN);

    erc20Factory = new ERC20Test__factory(signer);
    feeToken = await erc20Factory.deploy('FeeToken', 'FEE', '1000000', 18);
    feeToken2 = await erc20Factory.deploy('FeeToken2', 'FEE2', '1000000', 18);
  });

  describe('Create', async () => {
    it('should deploy an ICA with ISM', async () => {
      const evmIcaModule = await EvmIcaModule.create({
        chain,
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
        chain,
        config,
        multiProvider,
      });

      const actual = await evmIcaModule.read();
      expect(actual.commitmentIsm).to.deep.contain(config.commitmentIsm);
    });
  });

  describe('feeTokenApprovals', async () => {
    let evmIcaModule: EvmIcaModule;
    let routerAddress: string;
    const mockHookAddress = '0x1234567890123456789012345678901234567890';
    const mockHookAddress2 = '0xabcdef0123456789abcdef0123456789abcdef01';

    beforeEach(async () => {
      evmIcaModule = await EvmIcaModule.create({
        chain,
        config: {
          mailbox: mailbox.address,
          owner: signer.address,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            urls: ['https://example.com'],
            owner: signer.address,
          },
        },
        multiProvider,
      });
      routerAddress = evmIcaModule.serialize().interchainAccountRouter;
    });

    it('should generate approval tx when allowance is zero', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: feeToken.address, hook: mockHookAddress },
      ];

      const txs = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals,
      });

      expect(txs.length).to.equal(1);
      expect(txs[0].annotation).to.include('Approving hook');
      expect(txs[0].annotation).to.include(mockHookAddress);
      expect(txs[0].annotation).to.include(feeToken.address);
    });

    it('should set infinite approval after executing tx', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: feeToken.address, hook: mockHookAddress },
      ];

      const txs = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals,
      });

      await sendTxs(txs);

      const provider = multiProvider.getProvider(chain);
      const token = IERC20__factory.connect(feeToken.address, provider);
      const allowance = await token.allowance(routerAddress, mockHookAddress);
      expect(allowance.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
    });

    it('should not generate tx when approval is already at max', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: feeToken.address, hook: mockHookAddress },
      ];

      // First update to set approval
      const txs1 = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals,
      });
      await sendTxs(txs1);

      // Second update should not generate new txs for same approval
      const txs2 = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals,
      });

      expect(txs2.length).to.equal(0);
    });

    it('should handle multiple fee token approvals', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: feeToken.address, hook: mockHookAddress },
        { feeToken: feeToken2.address, hook: mockHookAddress2 },
      ];

      const txs = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals,
      });

      expect(txs.length).to.equal(2);

      await sendTxs(txs);

      const provider = multiProvider.getProvider(chain);
      const token1 = IERC20__factory.connect(feeToken.address, provider);
      const token2 = IERC20__factory.connect(feeToken2.address, provider);

      const allowance1 = await token1.allowance(routerAddress, mockHookAddress);
      const allowance2 = await token2.allowance(
        routerAddress,
        mockHookAddress2,
      );

      expect(allowance1.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
      expect(allowance2.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
    });

    it('should return empty array when feeTokenApprovals is empty', async () => {
      const txs = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
        feeTokenApprovals: [],
      });

      expect(txs.length).to.equal(0);
    });

    it('should return empty array when feeTokenApprovals is undefined', async () => {
      const txs = await evmIcaModule.update({
        mailbox: mailbox.address,
        owner: signer.address,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://example.com'],
          owner: signer.address,
        },
      });

      expect(txs.length).to.equal(0);
    });
  });
});
