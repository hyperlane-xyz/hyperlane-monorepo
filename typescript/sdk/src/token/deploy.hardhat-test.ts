import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { RouterConfig, TestChainName } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap } from '../types.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import {
  HypERC20CollateralConfig,
  HypERC20Config,
  TokenConfig,
  TokenType,
} from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { WarpRouteDeployConfig } from './types.js';

describe('TokenDeployer', async () => {
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
  let routerConfigMap: ChainMap<RouterConfig>;
  let config: WarpRouteDeployConfig;

  before(async () => {
    [signer] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const ismFactoryDeployer = new HyperlaneProxyFactoryDeployer(multiProvider);
    const factories = await ismFactoryDeployer.deploy(
      multiProvider.mapKnownChains(() => ({})),
    );
    const ismFactory = new HyperlaneIsmFactory(factories, multiProvider);
    coreApp = await new TestCoreDeployer(multiProvider, ismFactory).deployApp();
    routerConfigMap = coreApp.getRouterConfig(signer.address);
    config = objMap(
      routerConfigMap,
      (chain, c): HypERC20Config => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: 18,
        totalSupply: 100_000,
        gas: 65_000,
        ...c,
      }),
    );
  });

  beforeEach(async () => {
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config as ChainMap<TokenConfig & RouterConfig>);
  });

  describe('ERC20WarpRouterReader', async () => {
    const TOKEN_NAME = 'fake';
    const TOKEN_SUPPLY = '100000000000000000000';
    const TOKEN_DECIMALS = 18;
    let erc20Factory: ERC20Test__factory;
    let token: ERC20Test;

    before(async () => {
      erc20Factory = new ERC20Test__factory(signer);
      token = await erc20Factory.deploy(
        TOKEN_NAME,
        TOKEN_NAME,
        TOKEN_SUPPLY,
        TOKEN_DECIMALS,
      );
    });
    async function deriveWarpConfig(chainName: string, address: string) {
      return new EvmERC20WarpRouteReader(
        multiProvider,
        chainName,
      ).deriveWarpRouteConfig(address);
    }
    it('should derive ERC20RouterConfig from collateral correctly', async () => {
      const baseConfig = routerConfigMap[TestChainName.test1];
      const mailbox = Mailbox__factory.connect(baseConfig.mailbox, signer);

      // Create config
      const config: { [key: string]: any } = {
        [TestChainName.test1]: {
          type: TokenType.collateral,
          token: token.address,
          hook: await mailbox.defaultHook(),
          gas: 65_000,
          ...baseConfig,
        },
      };
      // Deploy with config
      const warpRoute = await deployer.deploy(
        config as ChainMap<TokenConfig & RouterConfig>,
      );

      // Derive config and check if each value matches
      const derivedConfig: Partial<HypERC20CollateralConfig> =
        await deriveWarpConfig(
          TestChainName.test1,
          warpRoute[TestChainName.test1].collateral.address,
        );

      for (const [key, value] of Object.entries(derivedConfig)) {
        const deployedValue = config[TestChainName.test1][key];
        if (deployedValue) expect(deployedValue).to.equal(value);
      }

      // Check if token values matches
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
    });
  });
});
