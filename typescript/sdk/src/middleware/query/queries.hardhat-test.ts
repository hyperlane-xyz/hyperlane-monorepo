import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainQueryRouter,
  TestQuery,
  TestQuery__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { Chains } from '../../consts/chains';
import { HyperlaneContracts } from '../../contracts';
import { TestCoreApp } from '../../core/TestCoreApp';
import { TestCoreDeployer } from '../../core/TestCoreDeployer';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { deployTestIgpsAndGetRouterConfig } from '../../test/testUtils';
import { ChainMap } from '../../types';

import { InterchainQuery } from './InterchainQuery';
import { InterchainQueryChecker } from './InterchainQueryChecker';
import { InterchainQueryDeployer } from './InterchainQueryDeployer';
import { interchainQueryFactories } from './contracts';

describe('InterchainQueryRouter', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;
  const localDomain = chainMetadata[localChain].chainId;
  const remoteDomain = chainMetadata[remoteChain].chainId;

  let contracts: ChainMap<HyperlaneContracts<typeof interchainQueryFactories>>;
  let signer: SignerWithAddress;
  let local: InterchainQueryRouter;
  let remote: InterchainQueryRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<RouterConfig>;
  let testQuery: TestQuery;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);
    config = await deployTestIgpsAndGetRouterConfig(
      multiProvider,
      signer.address,
      coreContractsMaps,
    );
  });

  beforeEach(async () => {
    const InterchainQuery = new InterchainQueryDeployer(multiProvider, config);

    contracts = await InterchainQuery.deploy();

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
    const bytes32sender = utils.addressToBytes32(sender);
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
