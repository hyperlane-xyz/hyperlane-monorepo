import {
  ERC20__factory,
  ERC721Enumerable__factory,
  IERC4626__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import { isEVMLike } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';
import { readContractsWithMulticall } from '../utils/multicall.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { TokenType } from './config.js';
import {
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isEverclearCollateralTokenConfig,
  isEverclearEthBridgeTokenConfig,
  isCrossCollateralTokenConfig,
  isNativeTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from './types.js';

export async function deriveTokenMetadata(
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
    }
  }

  await Promise.all(
    sortedEntries.map(async ([chain, config]) => {
      if (!isEVMLike(multiProvider.getProtocol(chain))) {
        return;
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
        }
        return;
      }

      if (
        isCollateralTokenConfig(config) ||
        isCrossCollateralTokenConfig(config) ||
        isXERC20TokenConfig(config) ||
        isCctpTokenConfig(config) ||
        isEverclearCollateralTokenConfig(config)
      ) {
        const provider = multiProvider.getProvider(chain);
        const batchContractAddress =
          multiProvider.getChainMetadata(chain).batchContractAddress;

        if (config.isNft) {
          const erc721Interface = ERC721Enumerable__factory.createInterface();
          const [name, symbol] = (await readContractsWithMulticall(
            provider,
            [
              {
                target: config.token,
                contractInterface: erc721Interface,
                method: 'name',
              },
              {
                target: config.token,
                contractInterface: erc721Interface,
                method: 'symbol',
              },
            ],
            'latest',
            batchContractAddress,
            chain,
          )) as [string, string];
          metadataMap.update(
            chain,
            TokenMetadataSchema.parse({
              name,
              symbol,
            }),
          );
          return;
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

        const erc20Interface = ERC20__factory.createInterface();
        const [name, symbol, decimals] = (await readContractsWithMulticall(
          provider,
          [
            {
              target: token,
              contractInterface: erc20Interface,
              method: 'name',
            },
            {
              target: token,
              contractInterface: erc20Interface,
              method: 'symbol',
            },
            {
              target: token,
              contractInterface: erc20Interface,
              method: 'decimals',
            },
          ],
          'latest',
          batchContractAddress,
          chain,
        )) as [string, string, number];

        metadataMap.update(
          chain,
          TokenMetadataSchema.parse({
            name,
            symbol,
            decimals,
          }),
        );
      }
    }),
  );

  metadataMap.finalize();
  return metadataMap;
}
