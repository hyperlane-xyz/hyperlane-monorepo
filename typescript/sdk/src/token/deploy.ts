/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { constants } from 'ethers';

import {
  ERC20__factory,
  ERC721Enumerable__factory,
  GasRouter,
  IERC4626__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import { TokenType } from '@hyperlane-xyz/sdk';
import { assert, objKeys, objMap, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterDeployer } from '../router/GasRouterDeployer.js';
import { ChainName } from '../types.js';

import { gasOverhead } from './config.js';
import {
  HypERC20Factories,
  HypERC721Factories,
  TokenFactories,
  hypERC20contracts,
  hypERC20factories,
  hypERC721contracts,
  hypERC721factories,
} from './contracts.js';
import {
  TokenMetadataSchema,
  TokenRouterConfig,
  isCollateralConfig,
  isNativeConfig,
  isSyntheticConfig,
  isSyntheticRebaseConfig,
  isTokenMetadata,
} from './schemas.js';
import { TokenMetadata, WarpRouteDeployConfig } from './types.js';

abstract class TokenDeployer<
  Factories extends TokenFactories,
> extends GasRouterDeployer<TokenRouterConfig, Factories> {
  constructor(
    multiProvider: MultiProvider,
    factories: Factories,
    loggerName: string,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = false,
  ) {
    super(multiProvider, factories, {
      logger: rootLogger.child({ module: loggerName }),
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    }); // factories not used in deploy
  }

  async constructorArgs(_: ChainName, config: TokenRouterConfig): Promise<any> {
    if (isCollateralConfig(config)) {
      return [config.token, config.mailbox];
    } else if (isNativeConfig(config)) {
      return config.scale ? [config.scale, config.mailbox] : [config.mailbox];
    } else if (isSyntheticConfig(config)) {
      assert(config.decimals, 'decimals is undefined for config'); // decimals must be defined by this point
      return [config.decimals, config.mailbox];
    } else if (isSyntheticRebaseConfig(config)) {
      const collateralDomain = this.multiProvider.getDomainId(
        config.collateralChainName,
      );
      return [config.decimals, config.mailbox, collateralDomain];
    } else {
      throw new Error('Unknown token type when constructing arguments');
    }
  }

  async initializeArgs(
    chain: ChainName,
    config: TokenRouterConfig,
  ): Promise<any> {
    const signer = await this.multiProvider.getSigner(chain).getAddress();
    const defaultArgs = [
      config.hook ?? constants.AddressZero,
      config.interchainSecurityModule ?? constants.AddressZero,
      // TransferOwnership will happen later in RouterDeployer
      signer,
    ];
    if (isCollateralConfig(config) || isNativeConfig(config)) {
      return defaultArgs;
    } else if (isSyntheticConfig(config)) {
      return [config.totalSupply, config.name, config.symbol, ...defaultArgs];
    } else if (isSyntheticRebaseConfig(config)) {
      return [0, config.name, config.symbol, ...defaultArgs];
    } else {
      throw new Error('Unknown collateral type when initializing arguments');
    }
  }

  static async deriveTokenMetadata(
    multiProvider: MultiProvider,
    configMap: WarpRouteDeployConfig,
  ): Promise<TokenMetadata | undefined> {
    // this is used for synthetic token metadata and should always be 0
    const DERIVED_TOKEN_SUPPLY = 0;

    for (const [chain, config] of Object.entries(configMap)) {
      if (isTokenMetadata(config)) {
        return TokenMetadataSchema.parse(config);
      }

      if (isNativeConfig(config)) {
        const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
        if (nativeToken) {
          return TokenMetadataSchema.parse({
            totalSupply: DERIVED_TOKEN_SUPPLY,
            ...nativeToken,
          });
        }
      }

      if (isCollateralConfig(config)) {
        const provider = multiProvider.getProvider(chain);

        if (config.isNft) {
          const erc721 = ERC721Enumerable__factory.connect(
            config.token,
            provider,
          );
          const [name, symbol] = await Promise.all([
            erc721.name(),
            erc721.symbol(),
          ]);
          return TokenMetadataSchema.parse({
            name,
            symbol,
            totalSupply: DERIVED_TOKEN_SUPPLY,
          });
        }

        let token: string;
        switch (config.type) {
          case TokenType.XERC20Lockbox:
            token = await IXERC20Lockbox__factory.connect(
              config.token,
              provider,
            ).callStatic.ERC20();
            break;
          case TokenType.collateralVault:
            token = await IERC4626__factory.connect(
              config.token,
              provider,
            ).callStatic.asset();
            break;
          default:
            token = config.token;
            break;
        }

        const erc20 = ERC20__factory.connect(token, provider);
        const [name, symbol, decimals] = await Promise.all([
          erc20.name(),
          erc20.symbol(),
          erc20.decimals(),
        ]);

        return TokenMetadataSchema.parse({
          name,
          symbol,
          decimals,
          totalSupply: DERIVED_TOKEN_SUPPLY,
        });
      }
    }

    return undefined;
  }

  async deploy(configMap: WarpRouteDeployConfig) {
    let tokenMetadata: TokenMetadata | undefined;
    try {
      tokenMetadata = await TokenDeployer.deriveTokenMetadata(
        this.multiProvider,
        configMap,
      );
    } catch (err) {
      this.logger.error('Failed to derive token metadata', err, configMap);
      throw err;
    }

    const resolvedConfigMap = objMap(configMap, (_, config) => ({
      ...tokenMetadata,
      gas: gasOverhead(config.type),
      ...config,
    }));
    return super.deploy(resolvedConfigMap);
  }
}

export class HypERC20Deployer extends TokenDeployer<HypERC20Factories> {
  constructor(
    multiProvider: MultiProvider,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = false,
  ) {
    super(
      multiProvider,
      hypERC20factories,
      'HypERC20Deployer',
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    );
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): GasRouter {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key];
      }
    }
    throw new Error('No matching contract found');
  }

  routerContractKey(config: TokenRouterConfig): keyof HypERC20Factories {
    assert(config.type in hypERC20factories, 'Invalid ERC20 token type');
    return config.type as keyof HypERC20Factories;
  }

  routerContractName(config: TokenRouterConfig): string {
    return hypERC20contracts[this.routerContractKey(config)];
  }
}

export class HypERC721Deployer extends TokenDeployer<HypERC721Factories> {
  constructor(
    multiProvider: MultiProvider,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
  ) {
    super(
      multiProvider,
      hypERC721factories,
      'HypERC721Deployer',
      ismFactory,
      contractVerifier,
    );
  }

  router(contracts: HyperlaneContracts<HypERC721Factories>): GasRouter {
    for (const key of objKeys(hypERC721factories)) {
      if (contracts[key]) {
        return contracts[key];
      }
    }
    throw new Error('No matching contract found');
  }

  routerContractKey(config: TokenRouterConfig): keyof HypERC721Factories {
    assert(config.type in hypERC721factories, 'Invalid ERC721 token type');
    return config.type as keyof HypERC721Factories;
  }

  routerContractName(config: TokenRouterConfig): string {
    return hypERC721contracts[this.routerContractKey(config)];
  }
}
