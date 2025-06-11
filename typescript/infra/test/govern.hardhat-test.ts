import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import hre from 'hardhat';

import {
  InterchainAccountRouter,
  TestRecipient,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  AccountConfig,
  ChainMap,
  ChainName,
  CheckerViolation,
  HyperlaneApp,
  HyperlaneAppChecker,
  HyperlaneContractsMap,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  IcaRouterConfig,
  InterchainAccount,
  InterchainAccountDeployer,
  InterchainAccountFactories,
  IsmType,
  MultiProvider,
  OwnableConfig,
  TestChainName,
  TestCoreApp,
  TestCoreDeployer,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, CallData, eqAddress, objMap } from '@hyperlane-xyz/utils';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from '../src/govern/HyperlaneAppGovernor.js';

export class TestApp extends HyperlaneApp<{}> {}

export class TestChecker extends HyperlaneAppChecker<TestApp, OwnableConfig> {
  async checkChain(_: string): Promise<void> {
    this.addViolation({
      chain: TestChainName.test2,
      type: 'test',
      expected: 0,
      actual: 1,
    });
  }
}

export class HyperlaneTestGovernor extends HyperlaneAppGovernor<
  TestApp,
  OwnableConfig
> {
  protected async mapViolationToCall(_violation: CheckerViolation) {
    return undefined;
  }

  mockPushCall(chain: string, call: AnnotatedCallData): void {
    this.pushCall(chain, call);
  }

  async govern(_ = true, chain?: ChainName) {
    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    const chains = chain ? [chain] : Object.keys(this.calls);
    for (const chain of chains) {
      await this.mockSendCalls(chain, this.calls[chain]);
    }
  }

  protected async mockSendCalls(
    chain: ChainName,
    calls: CallData[],
  ): Promise<void> {
    for (const call of calls) {
      await this.checker.multiProvider.sendTransaction(chain, {
        to: call.to,
        data: call.data,
        value: call.value,
      });
    }
  }
}

describe('ICA governance', async () => {
  const localChain = TestChainName.test1;
  const remoteChain = TestChainName.test2;

  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let accountConfig: AccountConfig;
  let coreApp: TestCoreApp;
  // let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let routerConfig: ChainMap<IcaRouterConfig>;
  let contracts: HyperlaneContractsMap<InterchainAccountFactories>;
  let icaApp: InterchainAccount;
  let recipient: TestRecipient;
  let accountOwner: Address;
  let governor: HyperlaneTestGovernor;

  before(async () => {
    // @ts-ignore
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );

    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    routerConfig = objMap(
      coreApp.getRouterConfig(signer.address),
      (_, config): IcaRouterConfig => ({
        ...config,
        commitmentIsm: {
          type: IsmType.OFFCHAIN_LOOKUP,
          urls: ['https://commitment-read-ism.hyperlane.xyz'],
          owner: signer.address,
        },
      }),
    );
  });

  beforeEach(async () => {
    contracts = await new InterchainAccountDeployer(multiProvider).deploy(
      routerConfig,
    );
    // local = contracts[localChain].interchainAccountRouter;
    remote = contracts[remoteChain].interchainAccountRouter;
    icaApp = new InterchainAccount(contracts, multiProvider);

    accountConfig = {
      origin: TestChainName.test1,
      owner: signer.address,
      localRouter: remote.address,
    };

    accountOwner = await icaApp.deployAccount(remoteChain, accountConfig);

    const recipientF = new TestRecipient__factory(signer);
    recipient = await recipientF.deploy();

    const contractsMap = {
      [remoteChain]: {
        recipient,
      },
      [localChain]: {
        recipient,
      },
    };
    const configMap = {
      [localChain]: { owner: signer.address },
      [remoteChain]: { owner: accountOwner },
    };

    const app = new TestApp(contractsMap, multiProvider);
    const checker = new TestChecker(multiProvider, app, configMap);
    governor = new HyperlaneTestGovernor(checker, icaApp);

    await recipient.transferOwnership(accountOwner);
  });

  it('changes ISM on the remote recipient', async () => {
    // precheck
    const actualOwner = await recipient.owner();
    expect(actualOwner).to.equal(accountOwner);

    // arrange
    const newIsm = randomAddress();
    await governor.checkChain(TestChainName.test2);
    const call = {
      to: recipient.address,
      data: recipient.interface.encodeFunctionData(
        'setInterchainSecurityModule',
        [newIsm],
      ),
      value: BigNumber.from(0),
      description: 'Setting ISM on the test recipient',
    };
    governor.mockPushCall(remoteChain, call);

    // act
    await governor.govern(); // this is where the ICA inference happens
    await coreApp.processMessages();

    // assert
    const actualIsm = await recipient.interchainSecurityModule();
    expect(eqAddress(actualIsm, newIsm)).to.be.true;
  });

  it('transfer ownership back to the deployer', async () => {
    // precheck
    let actualOwner = await recipient.owner();
    expect(actualOwner).to.equal(accountOwner);

    // arrange
    const call = {
      to: recipient.address,
      data: recipient.interface.encodeFunctionData('transferOwnership', [
        signer.address,
      ]),
      value: BigNumber.from(0),
      description: 'Transfer ownership',
    };
    governor.mockPushCall(remoteChain, call);

    // act
    await governor.govern();
    await coreApp.processMessages();

    // assert
    actualOwner = await recipient.owner();
    expect(actualOwner).to.equal(signer.address);
  });
});
