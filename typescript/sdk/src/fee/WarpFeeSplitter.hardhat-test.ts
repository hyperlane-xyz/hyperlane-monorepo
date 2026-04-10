import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  HypERC20Collateral__factory,
  HypNative__factory,
  RoutingFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TestChainName } from '../consts/testChains.js';
import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { EvmWarpModule } from '../token/EvmWarpModule.js';
import { TokenType } from '../token/config.js';
import { HypTokenRouterConfig } from '../token/types.js';

import { EvmWarpFeeSplitterModule } from './WarpFeeSplitter.js';
import { TokenFeeType } from './types.js';

describe('EvmWarpFeeSplitterModule', () => {
  const chain = TestChainName.test4;
  const amount = 1_000;
  const lpBps = 2_500;
  const streamingPeriod = 1_000;

  let signer: SignerWithAddress;
  let feeOwner: SignerWithAddress;
  let protocolBeneficiary: SignerWithAddress;
  let multiProvider: MultiProvider;
  let proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
  let coreApp: TestCoreApp;
  let token: ERC20Test;

  before(async () => {
    [signer, feeOwner, protocolBeneficiary] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const proxyFactories = await new HyperlaneProxyFactoryDeployer(
      multiProvider,
    ).deploy(multiProvider.mapKnownChains(() => ({})));
    proxyFactoryFactories = serializeContracts(proxyFactories[chain]);

    const ismFactory = new HyperlaneIsmFactory(proxyFactories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();

    token = await new ERC20Test__factory(signer).deploy(
      'Test Token',
      'TST',
      '100000000000000000000',
      18,
    );
  });

  it('claims ERC20 fees to the splitter and streams LP donations', async () => {
    const baseConfig = coreApp.getRouterConfig(signer.address)[chain];
    const warpConfig: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.collateral,
      token: token.address,
      tokenFee: {
        type: TokenFeeType.RoutingFee,
        owner: feeOwner.address,
        feeContracts: {
          [chain]: {
            type: TokenFeeType.LinearFee,
            owner: feeOwner.address,
            bps: 100,
          },
        },
      },
    };
    const warpModule = await EvmWarpModule.create({
      chain,
      multiProvider,
      proxyFactoryFactories,
      config: warpConfig,
    });
    for (const tx of await warpModule.update(warpConfig)) {
      await multiProvider.sendTransaction(chain, tx);
    }

    const hubRouterAddress = warpModule.serialize().deployedTokenRoute;
    const hubRouter = HypERC20Collateral__factory.connect(
      hubRouterAddress,
      signer,
    );
    const routingFeeAddress = await TokenRouter__factory.connect(
      hubRouterAddress,
      signer,
    ).feeRecipient();
    const routingFee = RoutingFee__factory.connect(routingFeeAddress, feeOwner);

    expect(eqAddress(await routingFee.owner(), feeOwner.address)).to.be.true;

    const splitter = await EvmWarpFeeSplitterModule.create({
      multiProvider,
      chain,
      config: {
        owner: signer.address,
        hubRouter: hubRouterAddress,
        lpBps,
        protocolBeneficiary: protocolBeneficiary.address,
        streamingPeriod,
      },
    });
    expect((await splitter.read()).hubRouter).to.equal(hubRouterAddress);

    await token.mintTo(routingFeeAddress, amount);
    await routingFee.claim(splitter.contract.address);

    expect(await token.balanceOf(splitter.contract.address)).to.equal(amount);

    const lpDonation = (amount * lpBps) / 10_000;
    const totalAssetsBefore = await hubRouter.totalAssets();
    const protocolBalanceBefore = await token.balanceOf(
      protocolBeneficiary.address,
    );
    await splitter.notify(token.address);

    expect(await hubRouter.totalAssets()).to.equal(totalAssetsBefore);
    expect(await token.balanceOf(protocolBeneficiary.address)).to.equal(
      protocolBalanceBefore.add(amount - lpDonation),
    );

    await hre.network.provider.send('evm_increaseTime', [streamingPeriod / 2]);
    await hre.network.provider.send('evm_mine');
    await splitter.drip(token.address);

    expect(await hubRouter.totalAssets()).to.equal(
      totalAssetsBefore.add(lpDonation / 2),
    );

    await hre.network.provider.send('evm_increaseTime', [streamingPeriod]);
    await hre.network.provider.send('evm_mine');
    await splitter.drip(token.address);

    expect(await hubRouter.totalAssets()).to.equal(
      totalAssetsBefore.add(lpDonation),
    );
    expect(await token.balanceOf(splitter.contract.address)).to.equal(0);
  });

  it('claims native fees to the splitter and streams LP donations', async () => {
    const nativeToken = hre.ethers.constants.AddressZero;
    const baseConfig = coreApp.getRouterConfig(signer.address)[chain];
    const warpConfig: HypTokenRouterConfig = {
      ...baseConfig,
      type: TokenType.native,
      tokenFee: {
        type: TokenFeeType.RoutingFee,
        owner: feeOwner.address,
        feeContracts: {
          [chain]: {
            type: TokenFeeType.LinearFee,
            owner: feeOwner.address,
            bps: 100,
          },
        },
      },
    };
    const warpModule = await EvmWarpModule.create({
      chain,
      multiProvider,
      proxyFactoryFactories,
      config: warpConfig,
    });
    for (const tx of await warpModule.update(warpConfig)) {
      await multiProvider.sendTransaction(chain, tx);
    }

    const hubRouterAddress = warpModule.serialize().deployedTokenRoute;
    const hubRouter = HypNative__factory.connect(hubRouterAddress, signer);
    const routingFeeAddress = await TokenRouter__factory.connect(
      hubRouterAddress,
      signer,
    ).feeRecipient();
    const routingFee = RoutingFee__factory.connect(routingFeeAddress, feeOwner);

    expect(eqAddress(await routingFee.owner(), feeOwner.address)).to.be.true;
    expect(await routingFee.token()).to.equal(nativeToken);

    const splitter = await EvmWarpFeeSplitterModule.create({
      multiProvider,
      chain,
      config: {
        owner: signer.address,
        hubRouter: hubRouterAddress,
        lpBps,
        protocolBeneficiary: protocolBeneficiary.address,
        streamingPeriod,
      },
    });

    await signer.sendTransaction({
      to: routingFeeAddress,
      value: amount,
    });
    await routingFee.claim(splitter.contract.address);

    expect(
      await hre.ethers.provider.getBalance(splitter.contract.address),
    ).to.equal(amount);

    const lpDonation = (amount * lpBps) / 10_000;
    const totalAssetsBefore = await hubRouter.totalAssets();
    const protocolBalanceBefore = await hre.ethers.provider.getBalance(
      protocolBeneficiary.address,
    );
    await splitter.notify(nativeToken);

    expect(await hubRouter.totalAssets()).to.equal(totalAssetsBefore);
    expect(
      await hre.ethers.provider.getBalance(protocolBeneficiary.address),
    ).to.equal(protocolBalanceBefore.add(amount - lpDonation));

    await hre.network.provider.send('evm_increaseTime', [streamingPeriod]);
    await hre.network.provider.send('evm_mine');
    await splitter.drip(nativeToken);

    expect(await hubRouter.totalAssets()).to.equal(
      totalAssetsBefore.add(lpDonation),
    );
    expect(
      await hre.ethers.provider.getBalance(splitter.contract.address),
    ).to.equal(0);
  });
});
