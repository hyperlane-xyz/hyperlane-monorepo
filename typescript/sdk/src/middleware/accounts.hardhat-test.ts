import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainAccountRouter,
  TestIsm__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { testChainConnectionConfigs } from '../consts/chainConnectionConfigs';
import { TestCoreApp } from '../core/TestCoreApp';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { InterchainAccountDeployer } from '../deploy/middleware/deploy';
import { RouterConfig } from '../deploy/router/types';
import { getChainToOwnerMap, getTestMultiProvider } from '../deploy/utils';
import { ChainNameToDomainId } from '../domains';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, TestChainNames } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

describe('InterchainAccountRouter', async () => {
  const localChain = 'test1';
  const remoteChain = 'test2';
  const localDomain = ChainNameToDomainId[localChain];
  const remoteDomain = ChainNameToDomainId[remoteChain];

  let signer: SignerWithAddress;
  let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let multiProvider: MultiProvider<TestChainNames>;
  let coreApp: TestCoreApp;
  let config: ChainMap<TestChainNames, RouterConfig>;

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
    const InterchainAccount = new InterchainAccountDeployer(
      multiProvider,
      config,
      coreApp,
    );
    const contracts = await InterchainAccount.deploy();

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;
  });

  it('sets default ISM', async () => {
    const localIsm = await local.interchainSecurityModule();
    const remoteIsm = await remote.interchainSecurityModule();
    expect(localIsm).to.eql(
      coreApp.getContracts(localChain).multisigIsm.address,
    );
    expect(remoteIsm).to.eql(
      coreApp.getContracts(remoteChain).multisigIsm.address,
    );
  });

  it('deploys and sets custom ISM', async () => {
    const ism = await new TestIsm__factory(signer).deploy();
    const ismConfig = objMap(config, (_, c) => ({
      ...c,
      interchainSecurityModule: ism.address,
    }));
    const deployer = new InterchainAccountDeployer(
      multiProvider,
      ismConfig,
      coreApp,
    );
    const contracts = await deployer.deploy();
    const deployedIsms = await promiseObjAll(
      objMap(contracts, (_, c) => c.router.interchainSecurityModule()),
    );
    expect(deployedIsms).to.eql(
      objMap(ismConfig, (_, c) => c.interchainSecurityModule),
    );
  });

  it('forwards calls from interchain account', async () => {
    const recipientF = new TestRecipient__factory(signer);
    const recipient = await recipientF.deploy();
    const fooMessage = 'Test';
    const data = recipient.interface.encodeFunctionData('fooBar', [
      1,
      fooMessage,
    ]);
    const icaAddress = await remote['getInterchainAccount(uint32,address)'](
      localDomain,
      signer.address,
    );

    await local.dispatch(remoteDomain, [
      {
        _call: { to: utils.addressToBytes32(recipient.address), data },
        value: 0,
      },
    ]);
    await coreApp.processMessages();
    expect(await recipient.lastCallMessage()).to.eql(fooMessage);
    expect(await recipient.lastCaller()).to.eql(icaAddress);
  });
});
