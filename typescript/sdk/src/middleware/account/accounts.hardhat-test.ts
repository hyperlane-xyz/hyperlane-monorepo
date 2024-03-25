import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

import {
  InterchainAccountRouter,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';

import { Chains } from '../../consts/chains';
import { HyperlaneContractsMap } from '../../contracts/types';
import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { HyperlaneAppChecker } from '../../deploy/HyperlaneAppChecker';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer';
import { HyperlaneAppGovernor } from '../../govern/HyperlaneAppGovernor';
import { HyperlaneIsmFactory } from '../../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap } from '../../types';

import { InterchainAccount } from './InterchainAccount';
import { InterchainAccountChecker } from './InterchainAccountChecker';
import { InterchainAccountDeployer } from './InterchainAccountDeployer';
import { InterchainAccountFactories } from './contracts';

describe('InterchainAccounts', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;

  let signer: SignerWithAddress;
  let contracts: HyperlaneContractsMap<InterchainAccountFactories>;
  let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let app: InterchainAccount;
  let config: ChainMap<RouterConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const ismFactory = new HyperlaneIsmFactory(
      await ismFactoryDeployer.deploy(multiProvider.mapKnownChains(() => ({}))),
      multiProvider,
    );
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    config = coreApp.getRouterConfig(signer.address);
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
      ethers.constants.AddressZero,
    );

    const call = { to: recipient.address, data, value: BigNumber.from(0) };
    const quote = await local.quoteGasPayment(
      multiProvider.getDomainId(remoteChain),
    );
    await app.callRemote(localChain, remoteChain, [call], quote);
    await coreApp.processMessages();
    expect(await recipient.lastCallMessage()).to.eql(fooMessage);
    expect(await recipient.lastCaller()).to.eql(icaAddress);
  });

  it('govern', async () => {
    const recipientF = new TestRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    const governor = HyperlaneAppGovernor(
      {} as HyperlaneAppChecker<any, any>,
      app,
    );
    await recipient.transferOwnership(
      app.getRemoteInterchainAccount(remoteChain, localChain, signer.address),
    );
    const call = {
      to: app.getAddresses,
      data: recipient.interface.encodeFunctionData('transferOwnership', [
        signer.address,
      ]),
      value: BigNumber.from(0),
    };
    governor.pushCall(localChain, call);

    // testGovernor
    // deploy recipient with ica
    // enqueue recipient transfer ownership to deployer
    // check ownership
  });
});
