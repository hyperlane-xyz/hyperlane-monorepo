import { constants } from 'ethers';

import {
  ERC20__factory,
  ERC721Enumerable__factory,
  GasRouter,
  IERC4626__factory,
  IMessageTransmitter__factory,
  IXERC20Lockbox__factory,
  OpL1V1NativeTokenBridge__factory,
  OpL2NativeTokenBridge__factory,
  TokenBridgeCctp__factory,
} from '@hyperlane-xyz/core';
import {
  ProtocolType,
  assert,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterDeployer } from '../router/GasRouterDeployer.js';
import { ChainMap, ChainName } from '../types.js';

import { TokenType, gasOverhead } from './config.js';
import {
  HypERC20Factories,
  HypERC20contracts,
  HypERC721Factories,
  TokenFactories,
  hypERC20contracts,
  hypERC20factories,
  hypERC721contracts,
  hypERC721factories,
} from './contracts.js';
import {
  CctpTokenConfig,
  HypTokenConfig,
  HypTokenRouterConfig,
  TokenMetadata,
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isNativeTokenConfig,
  isOpL1TokenConfig,
  isOpL2TokenConfig,
  isSyntheticRebaseTokenConfig,
  isSyntheticTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from './types.js';

// initialize(address _hook, address _owner)
const OP_L2_INITIALIZE_SIGNATURE = 'initialize(address,address)';
// initialize(address _owner, string[] memory _urls)
const OP_L1_INITIALIZE_SIGNATURE = 'initialize(address,string[])';
// initialize(address _hook, address _owner, string[] memory __urls)
const CCTP_INITIALIZE_SIGNATURE = 'initialize(address,address,string[])';

export const TOKEN_INITIALIZE_SIGNATURE = (
  contractName: HypERC20contracts[TokenType],
) => {
  switch (contractName) {
    case 'OPL2TokenBridgeNative':
      assert(
        OpL2NativeTokenBridge__factory.createInterface().functions[
          OP_L2_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return OP_L2_INITIALIZE_SIGNATURE;
    case 'OpL1TokenBridgeNative':
      assert(
        OpL1V1NativeTokenBridge__factory.createInterface().functions[
          OP_L1_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return OP_L1_INITIALIZE_SIGNATURE;
    case 'TokenBridgeCctp':
      assert(
        TokenBridgeCctp__factory.createInterface().functions[
          CCTP_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return CCTP_INITIALIZE_SIGNATURE;
    default:
      return 'initialize';
  }
};

abstract class TokenDeployer<
  Factories extends TokenFactories,
> extends GasRouterDeployer<HypTokenRouterConfig, Factories> {
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
    } else if (isOpL2TokenConfig(config)) {
      return [config.mailbox, config.l2Bridge];
    } else if (isOpL1TokenConfig(config)) {
      return [config.mailbox, config.portal];
    } else if (isSyntheticTokenConfig(config)) {
      assert(config.decimals, 'decimals is undefined for config'); // decimals must be defined by this point
      return [config.decimals, scale, config.mailbox];
    } else if (isSyntheticRebaseTokenConfig(config)) {
      const collateralDomain = this.multiProvider.getDomainId(
        config.collateralChainName,
      );
      return [config.decimals, scale, config.mailbox, collateralDomain];
    } else if (isCctpTokenConfig(config)) {
      return [
        config.token,
        scale,
        config.mailbox,
        config.messageTransmitter,
        config.tokenMessenger,
      ];
    } else {
      throw new Error('Unknown token type when constructing arguments');
    }
  }

  initializeFnSignature(name: string): string {
    return TOKEN_INITIALIZE_SIGNATURE(name as any);
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
    } else if (isOpL2TokenConfig(config)) {
      return [config.hook ?? constants.AddressZero, config.owner];
    } else if (isOpL1TokenConfig(config)) {
      return [config.owner, config.urls];
    } else if (isCctpTokenConfig(config)) {
      return [config.hook ?? constants.AddressZero, config.owner, config.urls];
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
  ): Promise<TokenMetadata | undefined> {
    for (const [chain, config] of Object.entries(configMap)) {
      if (isTokenMetadata(config)) {
        return TokenMetadataSchema.parse(config);
      } else if (multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
        // If the config didn't specify the token metadata, we can only now
        // derive it for Ethereum chains. So here we skip non-Ethereum chains.
        continue;
      }

      if (isNativeTokenConfig(config)) {
        const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
        if (nativeToken) {
          return TokenMetadataSchema.parse({
            ...nativeToken,
          });
        }
      }

      if (
        isCollateralTokenConfig(config) ||
        isXERC20TokenConfig(config) ||
        isCctpTokenConfig(config)
      ) {
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
        });
      }
    }

    return undefined;
  }

  protected async configureCctpDomains(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    const cctpConfigs = objFilter(
      configMap,
      (_, config): config is CctpTokenConfig => isCctpTokenConfig(config),
    );

    const circleDomains = await promiseObjAll(
      objMap(cctpConfigs, (chain, config) =>
        IMessageTransmitter__factory.connect(
          config.messageTransmitter,
          this.multiProvider.getProvider(chain),
        ).localDomain(),
      ),
    );

    const domains = Object.entries(circleDomains).map(([chain, circle]) => ({
      hyperlane: this.multiProvider.getDomainId(chain),
      circle,
    }));

    if (domains.length === 0) {
      return;
    }

    await promiseObjAll(
      objMap(cctpConfigs, async (chain, _config) => {
        const router = this.router(deployedContractsMap[chain]).address;
        const tokenBridge = TokenBridgeCctp__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );
        const remoteDomains = domains.filter(
          (domain) =>
            domain.hyperlane !== this.multiProvider.getDomainId(chain),
        );
        this.logger.info(`Mapping Circle domains on ${chain}`, {
          remoteDomains,
        });
        await this.multiProvider.handleTx(
          chain,
          tokenBridge.addDomains(remoteDomains),
        );
      }),
    );
  }

  async deploy(configMap: WarpRouteDeployConfigMailboxRequired) {
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
    const deployedContractsMap = await super.deploy(resolvedConfigMap);

    // Configure CCTP domains after all routers are deployed and remotes are enrolled (in super.deploy)
    await this.configureCctpDomains(configMap, deployedContractsMap);

    return deployedContractsMap;
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
