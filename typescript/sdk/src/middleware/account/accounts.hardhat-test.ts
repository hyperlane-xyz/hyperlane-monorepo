import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { constants, ethers } from 'ethers';
import hre from 'hardhat';
import sinon from 'sinon';

import {
  ERC20Test,
  ERC20Test__factory,
  IERC20__factory,
  InterchainAccountRouter,
  MinimalInterchainAccountRouter__factory,
  TestLegacyInterchainAccountRouter,
  TestLegacyInterchainAccountRouter__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  addressToBytes32,
  assert,
  eqAddress,
  formatStandardHookMetadata,
  objMap,
  parseMessage,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../../consts/testChains.js';
import { HyperlaneContractsMap } from '../../contracts/types.js';
import { TestCoreApp } from '../../core/TestCoreApp.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import {
  FeeTokenApproval,
  IcaRouterConfig,
  IcaRouterType,
} from '../../ica/types.js';

import { HyperlaneIsmFactory } from '../../ism/HyperlaneIsmFactory.js';
import { IsmType } from '../../ism/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { CallData } from '../../providers/transactions/types.js';
import { ChainMap } from '../../types.js';
import { isMissingSelectorCallException } from '../../utils/contract.js';

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
  let ismFactory: HyperlaneIsmFactory;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    ismFactory = new HyperlaneIsmFactory(
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
      local.address,
      constants.AddressZero,
    );

    const call = {
      to: recipient.address,
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
      localRouter: local.address,
    };
    await app.callRemote({
      chain: localChain,
      destination: remoteChain,
      innerCalls: [call],
      config,
    });
    const balanceAfter = await signer.getBalance();
    await coreApp.processMessages();
    expect(balanceAfter).to.lte(balanceBefore.sub(quote));
    expect(await recipient.lastCallMessage()).to.eql(fooMessage);
    expect(await recipient.lastCaller()).to.eql(icaAddress);
  });

  it('estimates handle gas directly with signer-connected routers', async () => {
    const recipient = await new TestRecipient__factory(signer).deploy();
    const calls: CallData[] = [
      {
        to: recipient.address,
        data: recipient.interface.encodeFunctionData('fooBar', [1, 'Direct']),
        value: '0',
      },
    ];
    const warn = sinon.spy(app.logger, 'warn');

    const gasLimit = await app.estimateIcaHandleGas({
      origin: localChain,
      destination: remoteChain,
      innerCalls: calls,
      config: {
        origin: localChain,
        owner: signer.address,
        localRouter: local.address,
      },
    });

    sinon.assert.notCalled(warn);
    const originDomain = multiProvider.getDomainId(localChain);
    const providerRouter = remote.connect(
      multiProvider.getProvider(remoteChain),
    );
    const body = app.encodeIcaMessageBody(
      addressToBytes32(signer.address),
      addressToBytes32(await providerRouter.isms(originDomain)),
      calls.map((call) => ({
        to: addressToBytes32(call.to),
        value: ethers.BigNumber.from(0),
        data: call.data,
      })),
    );
    const directEstimate = await providerRouter.estimateGas.handle(
      originDomain,
      addressToBytes32(local.address),
      body,
      { from: await providerRouter.mailbox() },
    );
    expect(gasLimit.toString()).to.equal(
      directEstimate.mul(110).div(100).toString(),
    );
  });

  describe('MinimalInterchainAccountRouter', async () => {
    it('deploys minimal router when routerType is MINIMAL', async () => {
      const minimalConfig = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          routerType: IcaRouterType.MINIMAL,
        }),
      );

      const minimalContracts = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(minimalConfig);

      const router = minimalContracts[localChain].interchainAccountRouter;
      expect(router.address).to.not.equal(constants.AddressZero);

      // Verify it's actually a MinimalInterchainAccountRouter by checking
      // implementation() exists (shared with full router) but CCIP_READ_ISM does not
      const minimalInstance = MinimalInterchainAccountRouter__factory.connect(
        router.address,
        signer,
      );
      const impl = await minimalInstance.implementation();
      expect(impl).to.not.equal(constants.AddressZero);
    });

    it('rejects minimal config with commitmentIsm set', async () => {
      const badConfig = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          routerType: IcaRouterType.MINIMAL,
          commitmentIsm: {
            type: IsmType.OFFCHAIN_LOOKUP,
            owner: signer.address,
            urls: ['some-url'],
          },
        }),
      );

      await expect(
        new InterchainAccountDeployer(multiProvider).deploy(badConfig),
      ).to.be.rejectedWith(
        'commitmentIsm must not be set for minimal ICA router deployments',
      );
    });

    it('rejects regular config without commitmentIsm', async () => {
      const badConfig = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          routerType: IcaRouterType.REGULAR,
        }),
      );

      await expect(
        new InterchainAccountDeployer(multiProvider).deploy(badConfig),
      ).to.be.rejectedWith(
        'commitmentIsm is required for regular ICA router deployments',
      );
    });

    it('forwards calls from interchain account via minimal router', async () => {
      const minimalConfig = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          routerType: IcaRouterType.MINIMAL,
        }),
      );

      const minimalContracts = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(minimalConfig);
      const minLocal = minimalContracts[localChain].interchainAccountRouter;
      const minRemote = minimalContracts[remoteChain].interchainAccountRouter;
      const minApp = new InterchainAccount(minimalContracts, multiProvider);

      const recipientF = new TestRecipient__factory(signer);
      const recipient = await recipientF.deploy();
      const fooMessage = 'TestMinimal';
      const data = recipient.interface.encodeFunctionData('fooBar', [
        1,
        fooMessage,
      ]);
      const icaAddress = await minRemote[
        'getLocalInterchainAccount(uint32,address,address,address)'
      ](
        multiProvider.getDomainId(localChain),
        signer.address,
        minLocal.address,
        constants.AddressZero,
      );

      const call = {
        to: recipient.address,
        data,
        value: '0',
      };
      const accountConfig: AccountConfig = {
        origin: localChain,
        owner: signer.address,
        localRouter: minLocal.address,
      };
      await minApp.callRemote({
        chain: localChain,
        destination: remoteChain,
        innerCalls: [call],
        config: accountConfig,
      });
      await coreApp.processMessages();
      expect(await recipient.lastCallMessage()).to.eql(fooMessage);
      expect(await recipient.lastCaller()).to.eql(icaAddress);
    });

    it('estimates handle gas with the packed body on minimal routers', async () => {
      const minimalConfig = objMap(
        coreApp.getRouterConfig(signer.address),
        (_, baseConfig): IcaRouterConfig => ({
          ...baseConfig,
          routerType: IcaRouterType.MINIMAL,
        }),
      );
      const minimalContracts = await new InterchainAccountDeployer(
        multiProvider,
      ).deploy(minimalConfig);
      // Mirror production, where routers are loaded with the full router ABI.
      const minApp = InterchainAccount.fromAddressesMap(
        objMap(minimalContracts, (_, chainContracts) => ({
          interchainAccountRouter:
            chainContracts.interchainAccountRouter.address,
        })),
        multiProvider,
      );
      const minLocal = minApp.getContracts(localChain).interchainAccountRouter;
      const minRemote =
        minApp.getContracts(remoteChain).interchainAccountRouter;

      const saltedLookupError = await minRemote[
        'getLocalInterchainAccount(uint32,bytes32,bytes32,address,bytes32)'
      ](
        multiProvider.getDomainId(localChain),
        ethers.utils.hexZeroPad(signer.address, 32),
        ethers.utils.hexZeroPad(minLocal.address, 32),
        constants.AddressZero,
        constants.HashZero,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isMissingSelectorCallException(saltedLookupError)).to.be.true;

      const recipient = await new TestRecipient__factory(signer).deploy();
      const warn = sinon.spy(minApp.logger, 'warn');

      const gasLimit = await minApp.estimateIcaHandleGas({
        origin: localChain,
        destination: remoteChain,
        innerCalls: [
          {
            to: recipient.address,
            data: recipient.interface.encodeFunctionData('fooBar', [
              1,
              'TestMinimal',
            ]),
            value: '0',
          },
        ],
        // routerOverride connects the destination router to a provider; a
        // signer-connected contract rejects the `from: mailbox` override.
        config: {
          origin: localChain,
          owner: signer.address,
          localRouter: minLocal.address,
          routerOverride: minRemote.address,
        },
      });

      sinon.assert.notCalled(warn);
      expect(gasLimit.gt(0)).to.be.true;
    });
  });

  describe('TestLegacyInterchainAccountRouter', async () => {
    let legacyCoreApp: TestCoreApp;
    let legacyLocal: TestLegacyInterchainAccountRouter;
    let legacyRemote: TestLegacyInterchainAccountRouter;
    let legacyApp: InterchainAccount;
    let accountConfig: AccountConfig;
    let localDomain: number;
    let remoteDomain: number;

    before(async () => {
      // Dedicated mailboxes, so the outer suite's processMessages() never
      // re-delivers the messages these tests execute directly.
      legacyCoreApp = await new TestCoreDeployer(
        multiProvider,
        ismFactory,
      ).deployApp();
      localDomain = multiProvider.getDomainId(localChain);
      remoteDomain = multiProvider.getDomainId(remoteChain);
    });

    beforeEach(async () => {
      const factory = new TestLegacyInterchainAccountRouter__factory(signer);
      legacyLocal = await factory.deploy(
        legacyCoreApp.getContracts(localChain).mailbox.address,
      );
      legacyRemote = await factory.deploy(
        legacyCoreApp.getContracts(remoteChain).mailbox.address,
      );
      for (const router of [legacyLocal, legacyRemote]) {
        await (
          await router.initialize(
            constants.AddressZero,
            constants.AddressZero,
            signer.address,
          )
        ).wait();
      }
      await (
        await legacyLocal.enrollRemoteRouterAndIsm(
          remoteDomain,
          addressToBytes32(legacyRemote.address),
          constants.HashZero,
        )
      ).wait();
      await (
        await legacyRemote.enrollRemoteRouterAndIsm(
          localDomain,
          addressToBytes32(legacyLocal.address),
          constants.HashZero,
        )
      ).wait();

      legacyApp = InterchainAccount.fromAddressesMap(
        {
          [localChain]: { interchainAccountRouter: legacyLocal.address },
          [remoteChain]: { interchainAccountRouter: legacyRemote.address },
        },
        multiProvider,
      );
      // routerOverride connects the destination router to a provider; a
      // signer-connected contract rejects the `from: mailbox` override.
      accountConfig = {
        origin: localChain,
        owner: signer.address,
        localRouter: legacyLocal.address,
        routerOverride: legacyRemote.address,
      };
    });

    async function getLegacyAccount(): Promise<Address> {
      return legacyRemote[
        'getLocalInterchainAccount(uint32,address,address,address)'
      ](
        localDomain,
        signer.address,
        legacyLocal.address,
        constants.AddressZero,
      );
    }

    async function estimate(innerCalls: CallData[]): Promise<ethers.BigNumber> {
      return legacyApp.estimateIcaHandleGas({
        origin: localChain,
        destination: remoteChain,
        innerCalls,
        config: accountConfig,
      });
    }

    // Dispatches through the legacy origin router, then executes handle() on
    // the destination as its mailbox with exactly `gasLimit`.
    async function dispatchAndExecute(
      innerCalls: CallData[],
      gasLimit: ethers.BigNumber,
    ): Promise<ethers.ContractReceipt> {
      const dispatchReceipt = await multiProvider.sendTransaction(
        localChain,
        legacyApp.getCallRemote({
          chain: localChain,
          destination: remoteChain,
          innerCalls,
          config: accountConfig,
          hookMetadata: formatStandardHookMetadata({
            gasLimit: gasLimit.toBigInt(),
            refundAddress: signer.address,
          }),
        }),
      );
      const originMailbox = legacyCoreApp.getContracts(localChain).mailbox;
      const messages: unknown[] = dispatchReceipt.logs
        .filter((log) => eqAddress(log.address, originMailbox.address))
        .map((log) => originMailbox.interface.parseLog(log))
        .filter((event) => event.name === 'Dispatch')
        .map((event) => event.args.message);
      expect(messages).to.have.length(1);
      const [message] = messages;
      assert(typeof message === 'string', 'Expected a dispatched message');

      const destinationMailbox =
        legacyCoreApp.getContracts(remoteChain).mailbox.address;
      await hre.ethers.provider.send('hardhat_impersonateAccount', [
        destinationMailbox,
      ]);
      await hre.ethers.provider.send('hardhat_setBalance', [
        destinationMailbox,
        '0xde0b6b3a7640000',
      ]);
      try {
        const handleTx = await legacyRemote
          .connect(hre.ethers.provider.getSigner(destinationMailbox))
          .handle(
            localDomain,
            addressToBytes32(legacyLocal.address),
            parseMessage(message).body,
            { gasLimit },
          );
        return await handleTx.wait();
      } finally {
        await hre.ethers.provider.send('hardhat_stopImpersonatingAccount', [
          destinationMailbox,
        ]);
      }
    }

    async function recipientCall(
      message: string,
    ): Promise<{ recipient: Address; calls: CallData[] }> {
      const recipient = await new TestRecipient__factory(signer).deploy();
      return {
        recipient: recipient.address,
        calls: [
          {
            to: recipient.address,
            data: recipient.interface.encodeFunctionData('fooBar', [
              1,
              message,
            ]),
            value: '0',
          },
        ],
      };
    }

    it('estimates and executes handle including ICA creation on an undeployed ICA', async () => {
      const { recipient, calls } = await recipientCall('LegacyUndeployed');
      const ica = await getLegacyAccount();
      expect(await hre.ethers.provider.getCode(ica)).to.equal('0x');
      const warn = sinon.spy(legacyApp.logger, 'warn');

      const gasLimit = await estimate(calls);

      sinon.assert.notCalled(warn);
      const receipt = await dispatchAndExecute(calls, gasLimit);
      expect(receipt.status).to.equal(1);
      expect(await hre.ethers.provider.getCode(ica)).to.not.equal('0x');
      const testRecipient = TestRecipient__factory.connect(recipient, signer);
      expect(await testRecipient.lastCallMessage()).to.equal(
        'LegacyUndeployed',
      );
      expect(await testRecipient.lastCaller()).to.equal(ica);
    });

    it('estimates and executes handle on an already-deployed ICA', async () => {
      const { recipient, calls } = await recipientCall('LegacyDeployed');
      const ica = await getLegacyAccount();
      const undeployedGasLimit = await estimate(calls);
      await (
        await legacyRemote[
          'getDeployedInterchainAccount(uint32,address,address,address)'
        ](
          localDomain,
          signer.address,
          legacyLocal.address,
          constants.AddressZero,
        )
      ).wait();
      expect(await hre.ethers.provider.getCode(ica)).to.not.equal('0x');
      const warn = sinon.spy(legacyApp.logger, 'warn');

      const gasLimit = await estimate(calls);

      sinon.assert.notCalled(warn);
      expect(gasLimit.lt(undeployedGasLimit)).to.be.true;
      const receipt = await dispatchAndExecute(calls, gasLimit);
      expect(receipt.status).to.equal(1);
      const testRecipient = TestRecipient__factory.connect(recipient, signer);
      expect(await testRecipient.lastCallMessage()).to.equal('LegacyDeployed');
      expect(await testRecipient.lastCaller()).to.equal(ica);
    });

    // Makes provider.estimateGas fail for calldata starting with any of the
    // given selectors, passing every other estimate through to hardhat.
    function failEstimatesFor(selectors: string[]): () => void {
      const provider = multiProvider.getProvider(remoteChain);
      const estimateGas = sinon.stub(provider, 'estimateGas');
      estimateGas.callsFake(async (tx) => {
        const data = await tx.data;
        if (
          typeof data === 'string' &&
          selectors.some((selector) => data.startsWith(selector))
        ) {
          throw new Error('Forced estimate failure');
        }
        return estimateGas.wrappedMethod.call(provider, tx);
      });
      return () => estimateGas.restore();
    }

    it('falls back to per-call estimation when the handle simulation reverts', async () => {
      const token = await new ERC20Test__factory(signer).deploy(
        'Token',
        'TKN',
        '1000000',
        18,
      );
      const tokenRecipient = ethers.Wallet.createRandom().address;
      const calls: CallData[] = [
        {
          to: token.address,
          data: token.interface.encodeFunctionData('transfer', [
            tokenRecipient,
            100,
          ]),
          value: '0',
        },
      ];
      const ica = await getLegacyAccount();
      const warn = sinon.spy(legacyApp.logger, 'warn');

      // The ICA holds no tokens yet, so the direct handle() simulation reverts.
      const gasLimit = await estimate(calls);

      sinon.assert.calledOnce(warn);
      sinon.assert.calledWithMatch(
        warn,
        sinon.match.object,
        'Failed to estimate ICA handle gas, trying individual call estimation',
      );
      await (await token.transfer(ica, 100)).wait();
      const receipt = await dispatchAndExecute(calls, gasLimit);
      expect(receipt.status).to.equal(1);
      expect((await token.balanceOf(tokenRecipient)).toString()).to.equal(
        '100',
      );
    });

    it('adds the deployment gas fallback when the ICA deployment estimate also fails', async () => {
      // Storing a 128-byte message costs enough that the call estimate plus
      // overhead, or the 200k static fallback, cannot also cover deploying the
      // ICA; only an additive deployment allowance executes.
      const message = 'x'.repeat(128);
      const { recipient, calls } = await recipientCall(message);
      const ica = await getLegacyAccount();
      const warn = sinon.spy(legacyApp.logger, 'warn');
      const restore = failEstimatesFor([
        legacyRemote.interface.getSighash('handle'),
        legacyRemote.interface.getSighash(
          'getDeployedInterchainAccount(uint32,address,address,address)',
        ),
      ]);

      let gasLimit: ethers.BigNumber;
      try {
        gasLimit = await estimate(calls);
      } finally {
        restore();
      }

      expect(warn.callCount).to.equal(2);
      sinon.assert.calledWithMatch(
        warn,
        sinon.match.object,
        'Failed to estimate ICA handle gas, trying individual call estimation',
      );
      sinon.assert.calledWithMatch(
        warn,
        sinon.match.object,
        'Failed to estimate ICA deployment gas, using the deployment gas fallback',
      );
      expect(await hre.ethers.provider.getCode(ica)).to.equal('0x');
      const receipt = await dispatchAndExecute(calls, gasLimit);
      expect(receipt.status).to.equal(1);
      const testRecipient = TestRecipient__factory.connect(recipient, signer);
      expect(await testRecipient.lastCallMessage()).to.equal(message);
      expect(await testRecipient.lastCaller()).to.equal(ica);
    });
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
        { feeToken: feeToken.address, hook: mockHookAddress },
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
      const token = IERC20__factory.connect(feeToken.address, provider);
      const allowance = await token.allowance(
        localRouter.address,
        mockHookAddress,
      );

      expect(allowance.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
    });

    it('should approve multiple fee tokens during deployment', async () => {
      const feeTokenApprovals: FeeTokenApproval[] = [
        { feeToken: feeToken.address, hook: mockHookAddress },
        { feeToken: feeToken2.address, hook: mockHookAddress2 },
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
      const token1 = IERC20__factory.connect(feeToken.address, provider);
      const token2 = IERC20__factory.connect(feeToken2.address, provider);

      const allowance1 = await token1.allowance(
        localRouter.address,
        mockHookAddress,
      );
      const allowance2 = await token2.allowance(
        localRouter.address,
        mockHookAddress2,
      );

      expect(allowance1.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
      expect(allowance2.toBigInt()).to.equal(
        ethers.constants.MaxUint256.toBigInt(),
      );
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
        contractsWithEmptyApprovals[localChain].interchainAccountRouter.address,
      ).to.not.equal(constants.AddressZero);
    });

    it('should not fail when feeTokenApprovals is undefined', async () => {
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
        contractsWithoutApprovals[localChain].interchainAccountRouter.address,
      ).to.not.equal(constants.AddressZero);
    });
  });
});
