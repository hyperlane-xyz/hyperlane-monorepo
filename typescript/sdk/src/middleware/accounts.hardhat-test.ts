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
import { InterchainAccountDeployer } from '../deploy/middleware/deploy';
import { RouterConfig } from '../deploy/router/types';
import { MultiProvider } from '../providers/MultiProvider';
import { getTestOwnerConfig } from '../test/testUtils';
import { ChainMap } from '../types';

describe('InterchainAccountRouter', async () => {
  const localChain = Chains.test1;
  const remoteChain = Chains.test2;

  let signer: SignerWithAddress;
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
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);
    config = coreApp.extendWithConnectionClientConfig(
      getTestOwnerConfig(signer.address),
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
