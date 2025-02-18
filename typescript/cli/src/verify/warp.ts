import { ContractFactory } from 'ethers';

import {
  ChainMap,
  EvmERC20WarpRouteReader,
  MultiProvider,
  TokenType,
  WarpCoreConfig,
  hypERC20contracts,
  hypERC20factories,
} from '@hyperlane-xyz/sdk';
import { Address, assert, objFilter } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/context.js';
import { CommandContext } from '../context/types.js';
import { logBlue } from '../logger.js';

import { verifyProxyAndImplementation } from './helpers.js';

// Zircuit does not have an external API: https://docs.zircuit.com/dev-tools/block-explorer
const UNSUPPORTED_CHAINS = ['zircuit'];

export async function runVerifyWarpRoute({
  context,
  warpCoreConfig,
}: {
  context: CommandContext;
  warpCoreConfig: WarpCoreConfig;
}) {
  const { chainMetadata, registry, skipConfirmation } = context;

  let apiKeys: ChainMap<string> = {};
  if (!skipConfirmation)
    apiKeys = await requestAndSaveApiKeys(
      warpCoreConfig.tokens.map((t) => t.chainName),
      chainMetadata,
      registry,
    );

  for (const token of warpCoreConfig.tokens) {
    const { chainName } = token;
    if (UNSUPPORTED_CHAINS.includes(chainName)) {
      logBlue(`Unsupported chain ${chainName}. Skipping.`);
      continue;
    }
    assert(token.addressOrDenom, 'token.addressOrDenom is missing');
    await verifyProxyAndImplementation({
      context,
      address: token.addressOrDenom,
      chainName,
      apiKeys,
      getContractFactoryAndName: getWarpRouteFactoryAndName,
    });
  }
}

async function getWarpRouteFactoryAndName(
  multiProvider: MultiProvider,
  chainName: string,
  warpRouteAddress: Address,
): Promise<{
  factory: ContractFactory;
  contractName: string;
}> {
  const warpRouteReader = new EvmERC20WarpRouteReader(multiProvider, chainName);
  const tokenType = (await warpRouteReader.deriveTokenType(
    warpRouteAddress,
  )) as Exclude<TokenType, TokenType.syntheticUri | TokenType.collateralUri>;

  const factory = objFilter(
    hypERC20factories,
    (t, _contract): _contract is any => t === tokenType,
  )[tokenType];

  const contractName = hypERC20contracts[tokenType];
  return { factory, contractName };
}
