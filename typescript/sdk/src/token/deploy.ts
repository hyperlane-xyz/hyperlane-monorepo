import { constants } from 'ethers';

import {
  ERC20__factory,
  ERC721Enumerable__factory,
  GasRouter,
  IERC4626__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import {
  ProtocolType,
  assert,
  objKeys,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterDeployer } from '../router/GasRouterDeployer.js';
import { ChainName } from '../types.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { TokenType, gasOverhead } from './config.js';
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
  HypTokenRouterConfig,
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  isCollateralTokenConfig,
  isNativeTokenConfig,
  isSyntheticRebaseTokenConfig,
  isSyntheticTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from './types.js';

abstract class TokenDeployer<
  Factories extends TokenFactories,
> extends GasRouterDeployer<HypTokenRouterConfig, Factories> {
  constructor(
    multiProvider: MultiProvider,
    factories: Factories,
    loggerName: string,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = true,
  ) {
    super(multiProvider, factories, {
      logger: rootLogger.child({ module: loggerName }),
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    }); // factories not used in deploy
  }

  async constructorArgs(
    _: ChainName,
    config: HypTokenRouterConfig,
  ): Promise<any> {
    // TODO: derive as specified in https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/5296
    const scale = config.scale ?? 1;

    if (isCollateralTokenConfig(config) || isXERC20TokenConfig(config)) {
      return [config.token, scale, config.mailbox];
    } else if (isNativeTokenConfig(config)) {
      return [scale, config.mailbox];
    } else if (isSyntheticTokenConfig(config)) {
      assert(config.decimals !== undefined, 'decimals is undefined for config'); // decimals must be defined by this point
      return [config.decimals, scale, config.mailbox];
    } else if (isSyntheticRebaseTokenConfig(config)) {
      const collateralDomain = this.multiProvider.getDomainId(
        config.collateralChainName,
      );
      return [config.decimals, scale, config.mailbox, collateralDomain];
    } else {
      throw new Error('Unknown token type when constructing arguments');
    }
  }

  async initializeArgs(
    chain: ChainName,
    config: HypTokenRouterConfig,
  ): Promise<any> {
    const signer = await this.multiProvider.getSigner(chain).getAddress();
    const defaultArgs = [
      config.hook ?? constants.AddressZero,
      config.interchainSecurityModule ?? constants.AddressZero,
      // TransferOwnership will happen later in RouterDeployer
      signer,
    ];
    if (
      isCollateralTokenConfig(config) ||
      isXERC20TokenConfig(config) ||
      isNativeTokenConfig(config)
    ) {
      return defaultArgs;
    } else if (isSyntheticTokenConfig(config)) {
      return [
        config.initialSupply ?? 0,
        config.name,
        config.symbol,
        ...defaultArgs,
      ];
    } else if (isSyntheticRebaseTokenConfig(config)) {
      return [0, config.name, config.symbol, ...defaultArgs];
    } else {
      throw new Error('Unknown collateral type when initializing arguments');
    }
  }

  static async deriveTokenMetadata(
    multiProvider: MultiProvider,
    configMap: WarpRouteDeployConfig,
  ): Promise<TokenMetadataMap> {
    const metadataMap = new TokenMetadataMap();

    const priorityGetter = (type: string) => {
      return ['collateral', 'native'].indexOf(type);
    };

    const sortedEntries = Object.entries(configMap).sort(
      ([, a], [, b]) => priorityGetter(b.type) - priorityGetter(a.type),
    );

    for (const [chain, config] of sortedEntries) {
      if (isTokenMetadata(config)) {
        metadataMap.set(chain, TokenMetadataSchema.parse(config));
      } else if (multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
        // If the config didn't specify the token metadata, we can only now
        // derive it for Ethereum chains. So here we skip non-Ethereum chains.
        continue;
      }

      if (isNativeTokenConfig(config)) {
        const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
        if (nativeToken) {
          metadataMap.set(
            chain,
            TokenMetadataSchema.parse({
              ...nativeToken,
            }),
          );
          continue;
        }
      }

      if (isCollateralTokenConfig(config) || isXERC20TokenConfig(config)) {
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
          metadataMap.set(
            chain,
            TokenMetadataSchema.parse({
              name,
              symbol,
              decimals: 0,
            }),
          );
          continue;
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

        metadataMap.set(
          chain,
          TokenMetadataSchema.parse({
            name,
            symbol,
            decimals,
          }),
        );
      }
    }

    metadataMap.finalize();
    return metadataMap;
  }

  async deploy(configMap: WarpRouteDeployConfigMailboxRequired) {
    let tokenMetadataMap: TokenMetadataMap;
    try {
      tokenMetadataMap = await TokenDeployer.deriveTokenMetadata(
        this.multiProvider,
        configMap,
      );
    } catch (err) {
      this.logger.error('Failed to derive token metadata', err, configMap);
      throw err;
    }

    const resolvedConfigMap = objMap(configMap, (chain, config) => ({
      name: tokenMetadataMap.getName(chain),
      decimals: tokenMetadataMap.getDecimals(chain),
      symbol:
        tokenMetadataMap.getSymbol(chain) ||
        tokenMetadataMap.getDefaultSymbol(),
      scale: tokenMetadataMap.getScale(chain),
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
    concurrentDeploy = true,
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

  routerContractKey(config: HypTokenRouterConfig): keyof HypERC20Factories {
    assert(config.type in hypERC20factories, 'Invalid ERC20 token type');
    return config.type as keyof HypERC20Factories;
  }

  routerContractName(config: HypTokenRouterConfig): string {
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

  async constructorArgs(
    _: ChainName,
    config: HypTokenRouterConfig,
  ): Promise<any> {
    if (isCollateralTokenConfig(config) || isXERC20TokenConfig(config)) {
      // NFT collateral contracts need: [tokenAddress, mailbox]
      return [config.token, config.mailbox];
    } else if (isSyntheticTokenConfig(config)) {
      // NFT synthetic contracts need: [mailbox]
      return [config.mailbox];
    } else {
      throw new Error('Unknown NFT token type when constructing arguments');
    }
  }

  router(contracts: HyperlaneContracts<HypERC721Factories>): GasRouter {
    for (const key of objKeys(hypERC721factories)) {
      if (contracts[key]) {
        return contracts[key];
      }
    }
    throw new Error('No matching contract found');
  }

  routerContractKey(config: HypTokenRouterConfig): keyof HypERC721Factories {
    assert(config.type in hypERC721factories, 'Invalid ERC721 token type');
    return config.type as keyof HypERC721Factories;
  }

  routerContractName(config: HypTokenRouterConfig): string {
    return hypERC721contracts[this.routerContractKey(config)];
  }
}
