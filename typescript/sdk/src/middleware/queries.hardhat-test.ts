import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainQueryRouter,
  TestQuery,
  TestQuery__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { Chains, chainMetadata } from '../consts';
import { TestCoreApp, TestCoreDeployer } from '../core';
import { MultiProvider } from '../providers';
import { RouterConfig } from '../router';
import { getTestOwnerConfig } from '../test/testUtils';
import { ChainMap } from '../types';

import { InterchainQueryDeployer } from './deploy';

describe('InterchainQueryRouter', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;
  const localDomain = chainMetadata[localChain].chainId;
  const remoteDomain = chainMetadata[remoteChain].chainId;

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
    config = coreApp.extendWithConnectionClientConfig(
      getTestOwnerConfig(signer.address),
    );
  });

  beforeEach(async () => {
    const InterchainQuery = new InterchainQueryDeployer(multiProvider, config);

    const contracts = await InterchainQuery.deploy();

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;

    testQuery = await new TestQuery__factory(signer).deploy(local.address);
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
