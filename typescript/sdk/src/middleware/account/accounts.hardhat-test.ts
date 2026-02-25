import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { MaxUint256, ZeroAddress } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  IERC20__factory,
  InterchainAccountRouter,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import { objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { HyperlaneContractsMap } from '../../contracts/types.js';
import { TestCoreApp } from '../../core/TestCoreApp.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { FeeTokenApproval, IcaRouterConfig } from '../../ica/types.js';
import { HyperlaneIsmFactory } from '../../ism/HyperlaneIsmFactory.js';
import { IsmType } from '../../ism/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap } from '../../types.js';

import { InterchainAccount } from './InterchainAccount.js';
import { InterchainAccountChecker } from './InterchainAccountChecker.js';
import { InterchainAccountDeployer } from './InterchainAccountDeployer.js';
import { InterchainAccountFactories } from './contracts.js';
import { AccountConfig } from './types.js';

describe('InterchainAccounts', async () => {
  const localChain = TestChainName.test1;
  const remoteChain = TestChainName.test2;

  let signer: SignerWithAddress;
  let contracts: HyperlaneContractsMap<InterchainAccountFactories>;
  let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let app: InterchainAccount;
  let config: ChainMap<IcaRouterConfig>;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    config = objMap(
      coreApp.getRouterConfig(signer.address),
      (_, config): IcaRouterConfig => ({
        ...config,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          owner: signer.address,
          urls: ['some-url'],
        },
      }),
    );
  });

  beforeEach(async () => {
    contracts = await new InterchainAccountDeployer(multiProvider).deploy(
      config,
    );
    local = contracts[localChain].interchainAccountRouter;
    remote = contracts[remoteChain].interchainAccountRouter;
    app = new InterchainAccount(contracts, multiProvider);
  });

  it('checks', async () => {
    const checker = new InterchainAccountChecker(multiProvider, app, config);
    await checker.check();
    expect(checker.violations.length).to.eql(0);
  });

  it('forwards calls from interchain account', async () => {
    const recipientF = new TestRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    const recipientAddress = await recipient.getAddress();
    const localAddress = await local.getAddress();
    const fooMessage = 'Test';
    const data = recipient.interface.encodeFunctionData('fooBar', [
      1,
      fooMessage,
    ]);
    const icaAddress = await remote[
      'getLocalInterchainAccount(uint32,address,address,address)'
    ](
      multiProvider.getDomainId(localChain),
      signer.address,
      localAddress,
      ZeroAddress,
    );

    const call = {
      to: recipientAddress,
      data,
      value: '0',
    };
    const quote = await local['quoteGasPayment(uint32)'](
      multiProvider.getDomainId(remoteChain),
    );
    const balanceBefore = await signer.getBalance();
    const config: AccountConfig = {
      origin: localChain,
      owner: signer.address,
      localRouter: localAddress,
    };
    await app.callRemote({
      chain: localChain,
      destination: remoteChain,
      innerCalls: [call],
      config,
    });
    const balanceAfter = await signer.getBalance();
    await coreApp.processMessages();
    expect(balanceAfter <= balanceBefore - quote).to.be.true;
    expect(await recipient.lastCallMessage()).to.eql(fooMessage);
    expect(await recipient.lastCaller()).to.eql(icaAddress);
  });

  describe('feeTokenApprovals', async () => {
    let feeToken: ERC20Test;
    let feeToken2: ERC20Test;
    let erc20Factory: ERC20Test__factory;
    const mockHookAddress = '0x1234567890123456789012345678901234567890';
    const mockHookAddress2 = '0xabcdef0123456789abcdef0123456789abcdef01';

    before(async () => {
      erc20Factory = new ERC20Test__factory(signer);
      feeToken = await erc20Factory.deploy('FeeToken', 'FEE', '1000000', 18);
      feeToken2 = await erc20Factory.deploy('FeeToken2', 'FEE2', '1000000', 18);
    });

    it('should approve fee tokens for hooks during deployment', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: await feeToken.getAddress(), hook: mockHookAddress },
      ];

      const configWithApprovals = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            owner: signer.address,
            urls: ['some-url'],
          },
          feeTokenApprovals,
        }),
      );

      const contractsWithApprovals = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(configWithApprovals);

      const localRouter =
        contractsWithApprovals[localChain].interchainAccountRouter;

      const provider = multiProvider.getProvider(localChain);
      const token = IERC20__factory.connect(await feeToken.getAddress(), provider);
      const allowance = await token.allowance(
        await localRouter.getAddress(),
        mockHookAddress,
      );

      expect(allowance).to.equal(MaxUint256);
    });

    it('should approve multiple fee tokens during deployment', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: await feeToken.getAddress(), hook: mockHookAddress },
        { feeToken: await feeToken2.getAddress(), hook: mockHookAddress2 },
      ];

      const configWithApprovals = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            owner: signer.address,
            urls: ['some-url'],
          },
          feeTokenApprovals,
        }),
      );

      const contractsWithApprovals = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(configWithApprovals);

      const localRouter =
        contractsWithApprovals[localChain].interchainAccountRouter;

      const provider = multiProvider.getProvider(localChain);
      const token1 = IERC20__factory.connect(
        await feeToken.getAddress(),
        provider,
      );
      const token2 = IERC20__factory.connect(
        await feeToken2.getAddress(),
        provider,
      );

      const allowance1 = await token1.allowance(
        await localRouter.getAddress(),
        mockHookAddress,
      );
      const allowance2 = await token2.allowance(
        await localRouter.getAddress(),
        mockHookAddress2,
      );

      expect(allowance1).to.equal(MaxUint256);
      expect(allowance2).to.equal(MaxUint256);
    });

    it('should not fail when feeTokenApprovals is empty', async () => {
      const configWithEmptyApprovals = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            owner: signer.address,
            urls: ['some-url'],
          },
          feeTokenApprovals: [],
        }),
      );

      const contractsWithEmptyApprovals = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(configWithEmptyApprovals);

      expect(
        await contractsWithEmptyApprovals[
          localChain
        ].interchainAccountRouter.getAddress(),
      ).to.not.equal(ZeroAddress);
    });

    it('should not fail when feeTokenApprovals is undefined', async () => {
      // This uses the default config without feeTokenApprovals
      const configWithoutApprovals = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            owner: signer.address,
            urls: ['some-url'],
          },
        }),
      );

      const contractsWithoutApprovals = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(configWithoutApprovals);

      expect(
        await contractsWithoutApprovals[
          localChain
        ].interchainAccountRouter.getAddress(),
      ).to.not.equal(ZeroAddress);
    });
  });
});
