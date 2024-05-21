import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import hre from 'hardhat';

import { ERC20Test, ERC20Test__factory } from '@hyperlane-xyz/core';
import { objMap } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { TestCoreApp } from '../core/TestCoreApp.js';
import { TestCoreDeployer } from '../core/TestCoreDeployer.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmWarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { TokenType } from './config.js';
import { HypERC20Deployer } from './deploy.js';
import { CollateralConfig, TokenRouterConfig } from './schemas.js';
import { WarpRouteDeployConfig } from './types.js';

describe('TokenDeployer', async () => {
  let signer: SignerWithAddress;
  let deployer: HypERC20Deployer;
  let multiProvider: MultiProvider;
  let coreApp: TestCoreApp;
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
    const routerConfigMap = coreApp.getRouterConfig(signer.address);
    config = objMap(
      routerConfigMap,
      (chain, c): TokenRouterConfig => ({
        type: TokenType.synthetic,
        name: chain,
        symbol: `u${chain}`,
        decimals: 18,
        totalSupply: 100_000,
        ...c,
      }),
    );
  });

  beforeEach(async () => {
    deployer = new HypERC20Deployer(multiProvider);
  });

  it('deploys', async () => {
    await deployer.deploy(config);
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
      return new EvmWarpRouteReader(
        multiProvider,
        chainName,
      ).deriveWarpRouteConfig(address);
    }
    it('should derive ERC20RouterConfig from collateral correctly', async () => {
      // Create config
      const collateralConfig: WarpRouteDeployConfig = {
        [TestChainName.test1]: {
          ...config[TestChainName.test1],
          type: TokenType.collateral,
          token: token.address,
        },
      };
      // Deploy with config
      const warpRoute = await deployer.deploy(collateralConfig);

      // Derive config and check if each value matches
      const derivedConfig: Partial<CollateralConfig> = await deriveWarpConfig(
        TestChainName.test1,
        warpRoute[TestChainName.test1].collateral.address,
      );

      expect(derivedConfig).to.deep.equal(
        collateralConfig[TestChainName.test1],
      );

      // Check if token values matches
      expect(derivedConfig.name).to.equal(TOKEN_NAME);
      expect(derivedConfig.symbol).to.equal(TOKEN_NAME);
      expect(derivedConfig.decimals).to.equal(TOKEN_DECIMALS);
    });
  });
});
