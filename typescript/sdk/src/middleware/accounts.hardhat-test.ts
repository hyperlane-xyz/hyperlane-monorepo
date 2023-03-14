import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  InterchainAccountRouter,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains';
import { TestCoreApp } from '../core/TestCoreApp';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { RouterConfig } from '../router/types';
import { createRouterConfigMap } from '../test/testUtils';
import { ChainMap } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

import {
  InterchainAccountContracts,
  InterchainAccountDeployer,
} from './deploy';

describe('InterchainAccountRouter', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;

  let signer: SignerWithAddress;
  let contracts: ChainMap<InterchainAccountContracts>;
  let local: InterchainAccountRouter;
  let remote: InterchainAccountRouter;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let config: ChainMap<RouterConfig>;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    const igpDeployer = new TestIgpDeployer(multiProvider);
    const igpContractsMaps = await igpDeployer.deploy();
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);
    config = createRouterConfigMap(
      signer.address,
      coreContractsMaps,
      igpContractsMaps,
    );

    config.test1.interchainSecurityModule =
      coreApp.getContracts('test1').multisigIsm.address;
  });

  beforeEach(async () => {
    const InterchainAccount = new InterchainAccountDeployer(
      multiProvider,
      config,
    );
    contracts = await InterchainAccount.deploy();

    local = contracts[localChain].router;
    remote = contracts[remoteChain].router;
  });

  it('deploys and sets configured ISMs', async () => {
    const deployedIsms = await promiseObjAll(
      objMap(contracts, (_, c) => c.router.interchainSecurityModule()),
    );
    expect(deployedIsms).to.eql(
      objMap(
        config,
        (_, c) => c.interchainSecurityModule ?? ethers.constants.AddressZero,
      ),
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
      multiProvider.getDomainId(localChain),
      signer.address,
    );

    await local.dispatch(multiProvider.getDomainId(remoteChain), [
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
