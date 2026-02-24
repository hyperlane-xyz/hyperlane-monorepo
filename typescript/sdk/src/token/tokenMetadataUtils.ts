import {
  ERC20__factory,
  ERC721Enumerable__factory,
  IERC4626__factory,
  IXERC20Lockbox__factory,
} from '@hyperlane-xyz/core';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../providers/MultiProvider.js';

import { TokenMetadataMap } from './TokenMetadataMap.js';
import { TokenType } from './config.js';
import {
  TokenMetadataSchema,
  WarpRouteDeployConfig,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isEverclearCollateralTokenConfig,
  isEverclearEthBridgeTokenConfig,
  isNativeTokenConfig,
  isTokenMetadata,
  isXERC20TokenConfig,
} from './types.js';

type AddressReaderContract = {
  address: string;
  interface: {
    encodeFunctionData(functionName: string, args?: readonly unknown[]): string;
    decodeFunctionResult(functionName: string, data: `0x${string}`): unknown;
  };
};

async function readAddressWithCall(
  provider: ReturnType<MultiProvider['getProvider']>,
  contract: AddressReaderContract,
  functionName: string,
): Promise<string> {
  const result = await provider.call({
    to: contract.address,
    data: contract.interface.encodeFunctionData(functionName),
  });
  return String(
    contract.interface.decodeFunctionResult(
      functionName,
      result as `0x${string}`,
    ),
  );
}

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

    if (multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
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
      isXERC20TokenConfig(config) ||
      isCctpTokenConfig(config) ||
      isEverclearCollateralTokenConfig(config)
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
        metadataMap.update(
          chain,
          TokenMetadataSchema.parse({
            name,
            symbol,
          }),
        );
        continue;
      }

      let token: string;
      switch (config.type) {
        case TokenType.XERC20Lockbox:
          token = await readAddressWithCall(
            provider,
            IXERC20Lockbox__factory.connect(config.token, provider),
            'ERC20',
          );
          break;
        case TokenType.collateralVault:
          token = await readAddressWithCall(
            provider,
            IERC4626__factory.connect(config.token, provider),
            'asset',
          );
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
