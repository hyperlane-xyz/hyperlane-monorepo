import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  MockToken,
  MockToken__factory,
  TestTokenBridgeMessageRecipient__factory,
  TokenBridgeRouter,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { testChainConnectionConfigs } from '../consts/chainConnectionConfigs';
import { TestCoreApp } from '../core/TestCoreApp';
import { TestCoreDeployer } from '../core/TestCoreDeployer';
import { TokenBridgeApp } from '../deploy/middleware/TokenBridgeApp';
import {
  BridgeAdapterType,
  TokenBridgeConfig,
  TokenBridgeDeployer,
} from '../deploy/middleware/TokenBridgeRouterDeployer';
import { getChainToOwnerMap, getTestMultiProvider } from '../deploy/utils';
import { ChainNameToDomainId } from '../domains';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, TestChainNames } from '../types';
import { objMap } from '../utils/objects';

describe('TokenBridgeRouter', async () => {
  const localChain = 'test1';
  const remoteChain = 'test2';
  const remoteDomain = ChainNameToDomainId[remoteChain];

  let signer: SignerWithAddress;
  let local: TokenBridgeRouter;
  let multiProvider: MultiProvider<TestChainNames>;
  let coreApp: TestCoreApp;

  let tokenBridgeApp: TokenBridgeApp<TestChainNames>;
  let config: ChainMap<TestChainNames, TokenBridgeConfig>;
  let mockToken: MockToken;

  before(async () => {
    [signer] = await ethers.getSigners();

    multiProvider = getTestMultiProvider(signer);

    const coreDeployer = new TestCoreDeployer(multiProvider);
    const coreContractsMaps = await coreDeployer.deploy();
    coreApp = new TestCoreApp(coreContractsMaps, multiProvider);

    const mockTokenF = new MockToken__factory(signer);
    mockToken = await mockTokenF.deploy();

    config = coreApp.extendWithConnectionClientConfig(
      objMap(
        getChainToOwnerMap(testChainConnectionConfigs, signer.address),
        (_chain, conf) => ({
          ...conf,
          bridgeAdapterConfigs: [
            {
              type: BridgeAdapterType.Mock,
              mockTokenAddress: mockToken.address,
            },
          ],
        }),
      ),
    );
  });

  beforeEach(async () => {
    const TokenBridge = new TokenBridgeDeployer(multiProvider, config, coreApp);
    const contracts = await TokenBridge.deploy();

    tokenBridgeApp = new TokenBridgeApp(contracts, multiProvider);

    local = tokenBridgeApp.getContracts(localChain).router;
  });

  it('can transfer tokens', async () => {
    const recipientF = new TestTokenBridgeMessageRecipient__factory(signer);
    const recipient = await recipientF.deploy();

    const amount = 1000;
    await mockToken.mint(signer.address, amount);
    await mockToken.approve(local.address, amount);
    await local.dispatchWithTokens(
      remoteDomain,
      utils.addressToBytes32(recipient.address),
      '0x00',
      mockToken.address,
      amount,
      BridgeAdapterType.Mock,
    );

    const transferNonce = await tokenBridgeApp
      .getContracts(localChain)
      .mockBridgeAdapter!.nonce();

    await tokenBridgeApp
      .getContracts(remoteChain)
      .mockBridgeAdapter!.process(transferNonce);

    await coreApp.processMessages();

    expect((await mockToken.balanceOf(recipient.address)).toNumber()).to.eql(
      amount,
    );
  });
});
