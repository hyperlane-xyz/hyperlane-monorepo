import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  HypERC20Collateral__factory,
  RoutingFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TokenType } from '../token/config.js';
import { EvmWarpModule } from '../token/EvmWarpModule.js';
import { HypTokenRouterConfig } from '../token/types.js';

import { TokenFeeType } from './types.js';
import { EvmWarpFeeVaultModule } from './WarpFeeVault.js';

describe('EvmWarpFeeVaultModule', () => {
  const chain = TestChainName.test4;
  const amount = 1_000;
  const lpBps = 2_500;
  const streamingPeriod = 1_000;

  let signer: SignerWithAddress;
  let feeOwner: SignerWithAddress;
  let protocolBeneficiary: SignerWithAddress;
  let lpUser: SignerWithAddress;
  let multiProvider: MultiProvider;
  let proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
  let coreApp: TestCoreApp;
  let token: ERC20Test;

  before(async () => {
    [signer, feeOwner, protocolBeneficiary, lpUser] =
      await hre.ethers.getSigners();
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

  it('claims ERC20 fees to the vault and streams LP accounting', async () => {
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

    const vault = await EvmWarpFeeVaultModule.create({
      multiProvider,
      chain,
      config: {
        owner: signer.address,
        asset: token.address,
        hubRouter: hubRouterAddress,
        lpBps,
        protocolBeneficiary: protocolBeneficiary.address,
        streamingPeriod,
        name: 'Warp Fee Vault',
        symbol: 'WFV',
      },
    });
    expect((await vault.read()).hubRouter).to.equal(hubRouterAddress);

    await token.mintTo(lpUser.address, amount);
    await token.connect(lpUser).approve(vault.contract.address, amount);
    await vault.contract.connect(lpUser).deposit(amount, lpUser.address);
    expect(await hubRouter.totalAssets()).to.equal(amount);
    expect(await vault.contract.totalAssets()).to.equal(amount);

    await token.mintTo(routingFeeAddress, amount);
    await routingFee.claim(vault.contract.address);

    const lpFee = (amount * lpBps) / 10_000;
    const protocolBalanceBefore = await token.balanceOf(
      protocolBeneficiary.address,
    );
    await vault.notify();

    expect(await hubRouter.totalAssets()).to.equal(amount);
    expect(await vault.contract.totalAssets()).to.equal(amount);
    expect(await token.balanceOf(protocolBeneficiary.address)).to.equal(
      protocolBalanceBefore.add(amount - lpFee),
    );

    await hre.network.provider.send('evm_increaseTime', [streamingPeriod / 2]);
    await hre.network.provider.send('evm_mine');

    expect(await hubRouter.totalAssets()).to.equal(amount);
    expect(await vault.contract.totalAssets()).to.equal(amount + lpFee / 2);

    await hre.network.provider.send('evm_increaseTime', [streamingPeriod / 2]);
    await hre.network.provider.send('evm_mine');

    const maxWithdraw = await vault.contract.maxWithdraw(lpUser.address);
    expect(maxWithdraw).to.equal(amount + lpFee - 1);
    await vault.contract
      .connect(lpUser)
      .withdraw(maxWithdraw, lpUser.address, lpUser.address);

    expect(await token.balanceOf(vault.contract.address)).to.equal(0);
    expect(await hubRouter.totalAssets()).to.equal(1);
    expect(await vault.contract.totalAssets()).to.equal(1);
  });
});
