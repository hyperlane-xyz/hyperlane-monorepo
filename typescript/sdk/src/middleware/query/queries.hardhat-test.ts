import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  InterchainQueryRouter,
  TestQuery,
  TestQuery__factory,
} from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { TestChainName, test1, test2 } from '../../consts/testChains.js';
import { HyperlaneContractsMap } from '../../contracts/types.js';
import { TestCoreApp } from '../../core/TestCoreApp.js';
import { TestCoreDeployer } from '../../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { MailboxAddress, RouterConfig } from '../../router/types.js';
import { ChainMap } from '../../types.js';

import { InterchainQuery } from './InterchainQuery.js';
import { InterchainQueryChecker } from './InterchainQueryChecker.js';
import { InterchainQueryDeployer } from './InterchainQueryDeployer.js';
import { InterchainQueryFactories } from './contracts.js';

// eslint-disable-next-line jest/no-disabled-tests
describe.skip('InterchainQueryRouter', async () => {
  const localChain = TestChainName.test1;
  const remoteChain = TestChainName.test2;
  const localDomain = test1.domainId!;
  const remoteDomain = test2.domainId!;

  let contracts: HyperlaneContractsMap<InterchainQueryFactories>;
  let signer: SignerWithAddress;
  let local: InterchainQueryRouter;
  let remote: InterchainQueryRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<RouterConfig & MailboxAddress>;
  let testQuery: TestQuery;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
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
    contracts = await new InterchainQueryDeployer(multiProvider).deploy(config);
    local = contracts[localChain].interchainQueryRouter;
    remote = contracts[remoteChain].interchainQueryRouter;
    testQuery = await new TestQuery__factory(signer).deploy(local.address);
  });

  it('checks', async () => {
    const app = new InterchainQuery(contracts, multiProvider);
    const checker = new InterchainQueryChecker(multiProvider, app, config);
    await checker.check();
    expect(checker.violations.length).to.eql(0);
  });

  it('completes query round trip and invokes callback', async () => {
    const secret = 123;
    const sender = testQuery.address;
    const bytes32sender = addressToBytes32(sender);
    const expectedOwner = await remote.owner();
    await expect(testQuery.queryRouterOwner(remoteDomain, secret))
      .to.emit(local, 'QueryDispatched')
      .withArgs(remoteDomain, sender);
    const result = await coreApp.processOutboundMessages(localChain);
    const response = result.get(remoteChain)![0];
    await expect(response)
      .to.emit(remote, 'QueryExecuted')
      .withArgs(localDomain, bytes32sender);
    const result2 = await coreApp.processOutboundMessages(remoteChain);
    const response2 = result2.get(localChain)![0];
    await expect(response2)
      .to.emit(local, 'QueryResolved')
      .withArgs(remoteDomain, sender);
    await expect(response2)
      .to.emit(testQuery, 'Owner')
      .withArgs(secret, expectedOwner);
  });
});
