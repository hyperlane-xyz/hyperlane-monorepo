import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainAccountRouter,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';

import { Chains } from '../../consts/chains';
import { HyperlaneContractsMap } from '../../contracts';
import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { deployTestIgpsAndGetRouterConfig } from '../../test/testUtils';
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
  let config: ChainMap<RouterConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    coreApp = await new TestCoreDeployer(multiProvider).deployApp();
    config = await deployTestIgpsAndGetRouterConfig(
      multiProvider,
      signer.address,
      coreApp.contractsMap,
    );

    config.test1.interchainSecurityModule =
      coreApp.getContracts('test1').multisigIsm.address;
  });

  beforeEach(async () => {
    const deployer = new InterchainAccountDeployer(multiProvider);
    contracts = await deployer.deploy(config);
    local = contracts[localChain].interchainAccountRouter;
    remote = contracts[remoteChain].interchainAccountRouter;
  });

  it('checks', async () => {
    const app = new InterchainAccount(contracts, multiProvider);
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

    await local['callRemote(uint32,address,uint256,bytes)'](
      multiProvider.getDomainId(remoteChain),
      recipient.address,
      0,
      data,
    );
    await coreApp.processMessages();
    expect(await recipient.lastCallMessage()).to.eql(fooMessage);
    expect(await recipient.lastCaller()).to.eql(icaAddress);
  });
});
