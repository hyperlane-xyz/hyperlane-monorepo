import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  ChainMap,
  ChainNameToDomainId,
  MultiProvider,
  RouterConfig,
  TestChainNames,
  TestCoreApp,
  TestCoreDeployer,
  getChainToOwnerMap,
  getTestMultiProvider,
  testChainConnectionConfigs,
} from '@hyperlane-xyz/sdk';

import { InterchainQueryDeployer } from '../src/deploy';
import { InterchainQueryRouter } from '../types';
import { TestQuery, TestQuery__factory } from '../types';

describe('InterchainQueryRouter', async () => {
  const localChain = 'test1';
  const remoteChain = 'test2';
  const localDomain = ChainNameToDomainId[localChain];
  const remoteDomain = ChainNameToDomainId[remoteChain];

  let signer: SignerWithAddress;
  let local: InterchainQueryRouter;
  let remote: InterchainQueryRouter;
  let multiProvider: MultiProvider<TestChainNames>;
  let coreApp: TestCoreApp;
  let config: ChainMap<TestChainNames, RouterConfig>;
  let testQuery: TestQuery;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = getTestMultiProvider(signer);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);
    config = coreApp.extendWithConnectionClientConfig(
      getChainToOwnerMap(testChainConnectionConfigs, signer.address),
    );
  });

  beforeEach(async () => {
    const InterchainQuery = new InterchainQueryDeployer(
      multiProvider,
      config,
      coreApp,
    );

    const contracts = await InterchainQuery.deploy();

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;

    testQuery = await new TestQuery__factory(signer).deploy(local.address);
  });

  it('completes query round trip and invokes callback', async () => {
    const secret = 123;
    const expectedOwner = await remote.owner();
    await expect(testQuery.queryRouterOwner(remoteDomain, secret))
      .to.emit(local, 'QueryDispatched')
      .withArgs(remoteDomain, testQuery.address);
    const result = await coreApp.processOutboundMessages(localChain);
    const response = result.get(remoteChain)![0];
    await expect(response)
      .to.emit(remote, 'QueryReturned')
      .withArgs(localDomain, testQuery.address);
    const result2 = await coreApp.processOutboundMessages(remoteChain);
    const response2 = result2.get(localChain)![0];
    await expect(response2)
      .to.emit(local, 'QueryResolved')
      .withArgs(remoteDomain, testQuery.address);
    await expect(response2)
      .to.emit(testQuery, 'Owner')
      .withArgs(secret, expectedOwner);
  });
});
