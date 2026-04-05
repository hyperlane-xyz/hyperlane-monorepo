import {
  ERC20__factory,
  ERC721Enumerable__factory,
  IERC4626__factory,
  TokenBridgeOft__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import { assert, isEVMLike } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { TokenType } from './config.js';
import {
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isDepositAddressTokenConfig,
  isEverclearCollateralTokenConfig,
  isEverclearEthBridgeTokenConfig,
  isCrossCollateralTokenConfig,
  isKatanaRedeemIcaConfig,
  isKatanaVaultHelperConfig,
  isNativeTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from './types.js';

export async function deriveTokenMetadata(
  multiProvider: MultiProvider,
  configMap: WarpRouteDeployConfig,
): Promise<TokenMetadataMap> {
  const metadataMap = new TokenMetadataMap();
  const prioritizedTypes = new Set<string>([
    TokenType.collateral,
    TokenType.collateralVault,
    TokenType.collateralVaultRebase,
    TokenType.collateralCctp,
    TokenType.collateralDepositAddress,
    TokenType.collateralEverclear,
    TokenType.collateralKatanaVaultHelper,
    TokenType.nativeKatanaVaultHelper,
    TokenType.XERC20,
    TokenType.XERC20Lockbox,
    TokenType.native,
  ]);

  const priorityGetter = (type: string) => {
    if (prioritizedTypes.has(type)) {
      return 1;
    }
    return -1;
  };

  const sortedEntries = Object.entries(configMap).sort(
    ([, a], [, b]) => priorityGetter(b.type) - priorityGetter(a.type),
  );

  for (const [chain, config] of sortedEntries) {
    if (isTokenMetadata(config)) {
      metadataMap.set(chain, TokenMetadataSchema.parse(config));
    }

    if (!isEVMLike(multiProvider.getProtocol(chain))) {
      continue;
    }

    if (
      isNativeTokenConfig(config) ||
      isEverclearEthBridgeTokenConfig(config)
    ) {
      const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
      if (nativeToken) {
        metadataMap.update(
          chain,
          TokenMetadataSchema.parse({
            ...nativeToken,
          }),
        );
        continue;
      }
    }

    if (
      isCollateralTokenConfig(config) ||
      isCrossCollateralTokenConfig(config) ||
      isXERC20TokenConfig(config) ||
      isCctpTokenConfig(config) ||
      isDepositAddressTokenConfig(config) ||
      isKatanaVaultHelperConfig(config) ||
      isKatanaRedeemIcaConfig(config) ||
      isEverclearCollateralTokenConfig(config)
    ) {
      const provider = multiProvider.getProvider(chain);

      if (config.isNft && 'token' in config) {
        const erc721 = ERC721Enumerable__factory.connect(
          config.token,
          provider,
        );
        const [name, symbol] = await Promise.all([
          erc721.name(),
          erc721.symbol(),
        ]);
        metadataMap.update(
          chain,
          TokenMetadataSchema.parse({
            name,
            symbol,
          }),
        );
        continue;
      }

      let token: string | undefined;
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
        case TokenType.collateralKatanaVaultHelper:
          token = await IERC4626__factory.connect(
            config.shareVault,
            provider,
          ).callStatic.asset();
          break;
        case TokenType.nativeKatanaVaultHelper: {
          const nativeToken = multiProvider.getChainMetadata(chain).nativeToken;
          if (nativeToken) {
            metadataMap.update(
              chain,
              TokenMetadataSchema.parse({
                ...nativeToken,
              }),
            );
            continue;
          }
          token = await IERC4626__factory.connect(
            config.shareVault,
            provider,
          ).callStatic.asset();
          break;
        }
        case TokenType.collateralKatanaRedeemIca:
          token = await TokenBridgeOft__factory.connect(
            config.shareBridge,
            provider,
          ).callStatic.token();
          break;
        default:
          token = 'token' in config ? config.token : undefined;
          break;
      }

      assert(
        token,
        `Missing token address for metadata derivation on ${chain}`,
      );
      const erc20 = ERC20__factory.connect(token, provider);
      const [name, symbol, decimals] = await Promise.all([
        erc20.name(),
        erc20.symbol(),
        erc20.decimals(),
      ]);

      metadataMap.update(
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
