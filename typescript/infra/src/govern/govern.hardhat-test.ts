import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import {
  InterchainAccountRouter,
  TestRecipient,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import {
  AccountConfig,
  ChainMap,
  ChainName,
  Chains,
  HyperlaneApp,
  HyperlaneAppChecker,
  HyperlaneContractsMap,
  HyperlaneIsmFactory,
  HyperlaneProxyFactoryDeployer,
  InterchainAccount,
  InterchainAccountDeployer,
  MultiProvider,
  OwnableConfig,
  RouterConfig,
  TestCoreApp,
  TestCoreDeployer,
  randomAddress,
  resolveAccountOwner,
} from '@hyperlane-xyz/sdk';
import { InterchainAccountFactories } from '@hyperlane-xyz/sdk/dist/middleware/account/contracts';
import { Address, CallData, eqAddress } from '@hyperlane-xyz/utils';

import {
  AnnotatedCallData,
  HyperlaneAppGovernor,
} from './HyperlaneAppGovernor';

export class TestApp extends HyperlaneApp<{}> {}

export class TestChecker extends HyperlaneAppChecker<TestApp, OwnableConfig> {
  async checkChain(_: string): Promise<void> {
    this.addViolation({
      chain: Chains.test2,
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
  protected async mapViolationsToCalls() {
    return;
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
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;

  let signer: SignerWithAddress;
  let multiProvider: MultiProvider;
  let accountConfig: AccountConfig;
  let coreApp: TestCoreApp;
  // let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let routerConfig: ChainMap<RouterConfig>;
  let contracts: HyperlaneContractsMap<InterchainAccountFactories>;
  let icaApp: InterchainAccount;
  let recipient: TestRecipient;
  let accountOwner: Address;
  let governor: HyperlaneTestGovernor;

  before(async () => {
    [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );

    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    routerConfig = coreApp.getRouterConfig(signer.address);
  });

  beforeEach(async () => {
    contracts = await new InterchainAccountDeployer(multiProvider).deploy(
      routerConfig,
    );
    // local = contracts[localChain].interchainAccountRouter;
    remote = contracts[remoteChain].interchainAccountRouter;
    icaApp = new InterchainAccount(contracts, multiProvider);

    accountConfig = {
      origin: Chains.test1,
      owner: signer.address,
      localRouter: remote.address,
    };

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
    // missing ica
    const configMap = {
      [localChain]: { owner: signer.address },
      [remoteChain]: {
        owner: { origin: Chains.test1, owner: signer.address },
      },
    };

    const app = new TestApp(contractsMap, multiProvider);
    const checker = new TestChecker(multiProvider, app, configMap);
    governor = new HyperlaneTestGovernor(checker, icaApp);

    accountOwner = await resolveAccountOwner(
      multiProvider,
      remoteChain,
      accountConfig,
    );
    await recipient.transferOwnership(accountOwner);
  });

  it('changes ISM on the remote recipient', async () => {
    // precheck
    const actualOwner = await recipient.owner();
    expect(actualOwner).to.equal(accountOwner);

    // arrange
    const newIsm = randomAddress();
    await governor.checker.checkChain(Chains.test2);
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
    await governor.govern();
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
