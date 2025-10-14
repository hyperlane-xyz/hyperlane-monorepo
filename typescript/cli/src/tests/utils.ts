import * as chai from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  HypTokenRouterConfig,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, isObjEmpty } from '@hyperlane-xyz/utils';

import { readChainSubmissionStrategyConfig } from '../config/strategy.js';
import { AltVMProviderFactory, AltVMSignerFactory } from '../context/altvm.js';
import { getContext } from '../context/context.js';
import { CommandContext } from '../context/types.js';
import { extendWarpRoute } from '../deploy/warp.js';
import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { HyperlaneE2EWarpTestCommands } from './commands/warp.js';
import {
  DEFAULT_EVM_WARP_CORE_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  TEST_TOKEN_SYMBOL,
  getWarpCoreConfigPath,
} from './constants.js';

const expect = chai.expect;

export function assertWarpRouteConfig(
  warpDeployConfig: Readonly<WarpRouteDeployConfig>,
  derivedWarpDeployConfig: Readonly<WarpRouteDeployConfig>,
  coreAddressByChain: ChainMap<ChainAddresses>,
  chainName: ChainName,
): void {
  expect(derivedWarpDeployConfig[chainName].type).to.equal(
    warpDeployConfig[chainName].type,
  );
  expect(derivedWarpDeployConfig[chainName].owner).to.equal(
    warpDeployConfig[chainName].owner,
  );

  expect(warpDeployConfig[chainName].mailbox).to.equal(
    coreAddressByChain[chainName].mailbox,
  );
  expect(isObjEmpty(derivedWarpDeployConfig[chainName].destinationGas ?? {})).to
    .be.false;
  expect(isObjEmpty(derivedWarpDeployConfig[chainName].remoteRouters ?? {})).to
    .be.false;
}

export function getUnsupportedChainWarpCoreTokenConfig(): WarpCoreConfig['tokens'][number] {
  return {
    addressOrDenom: randomAddress(),
    chainName: TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN.name,
    connections: [],
    decimals: 6,
    name: TEST_TOKEN_SYMBOL,
    standard: TokenStandard.SealevelHypSynthetic,
    symbol: TEST_TOKEN_SYMBOL,
  };
}

export function exportWarpConfigsToFilePaths({
  warpRouteId,
  warpConfig,
  warpCoreConfig,
}: {
  warpRouteId: string;
  warpConfig: WarpRouteDeployConfig;
  warpCoreConfig: WarpCoreConfig;
}): {
  warpDeployPath: string;
  warpCorePath: string;
} {
  const basePath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}`;
  const updatedWarpConfigPath = `${basePath}-deploy.yaml`;
  const updatedWarpCorePath = `${basePath}-config.yaml`;
  writeYamlOrJson(updatedWarpConfigPath, warpConfig);
  writeYamlOrJson(updatedWarpCorePath, warpCoreConfig);

  return {
    warpDeployPath: updatedWarpConfigPath,
    warpCorePath: updatedWarpCorePath,
  };
}

/**
 * Retrieves the deployed Warp address from the Warp core config.
 */
export function getDeployedWarpAddress(chain: string, warpCorePath: string) {
  const warpCoreConfig: WarpCoreConfig = readYamlOrJson(warpCorePath);
  WarpCoreConfigSchema.parse(warpCoreConfig);
  return warpCoreConfig.tokens.find((t) => t.chainName === chain)!
    .addressOrDenom;
}

/**
 * Sets up an incomplete warp route extension for testing purposes.
 *
 * This function creates a new warp route configuration for the second chain.
 */
export async function setupIncompleteWarpRouteExtension(
  coreDeploymentAddressesOfChainToExtend: ChainAddresses,
  warpCommandModule: HyperlaneE2EWarpTestCommands,
): Promise<{
  chain2DomainId: string;
  chain3DomainId: string;
  warpConfigPath: string;
  configToExtend: HypTokenRouterConfig;
  context: CommandContext;
  combinedWarpCorePath: string;
}> {
  const warpConfigPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

  const chain2DomainId =
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.domainId;
  const chain3DomainId =
    TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3.domainId;

  const configToExtend: HypTokenRouterConfig = {
    decimals: 18,
    mailbox: coreDeploymentAddressesOfChainToExtend!.mailbox,
    name: 'Ether',
    owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
    symbol: 'ETH',
    type: TokenType.native,
  };

  const context = await getContext({
    registryUris: [REGISTRY_PATH],
    key: HYP_KEY_BY_PROTOCOL.ethereum,
  });

  const warpCoreConfig = readYamlOrJson(
    DEFAULT_EVM_WARP_CORE_PATH,
  ) as WarpCoreConfig;
  const warpDeployConfig = await warpCommandModule.readConfig(
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    DEFAULT_EVM_WARP_CORE_PATH,
  );

  warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
    configToExtend;

  const signer2 = new Wallet(
    HYP_KEY_BY_PROTOCOL.ethereum,
    context.multiProvider.getProvider(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    ),
  );
  const signer3 = new Wallet(
    HYP_KEY_BY_PROTOCOL.ethereum,
    context.multiProvider.getProvider(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ),
  );
  context.multiProvider.setSigner(
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    signer2,
  );
  context.multiProvider.setSigner(
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    signer3,
  );

  const strategyConfig = context.strategyPath
    ? await readChainSubmissionStrategyConfig(context.strategyPath)
    : {};

  context.altVmProvider = new AltVMProviderFactory(context.multiProvider);

  const altVmSigner = await AltVMSignerFactory.createSigners(
    context.multiProvider,
    [],
    {},
    strategyConfig,
  );

  await extendWarpRoute(
    {
      context: {
        ...context,
        signer: signer3,
        key: {
          [ProtocolType.Ethereum]: HYP_KEY_BY_PROTOCOL.ethereum,
        },
        altVmSigner,
      },
      warpCoreConfig,
      warpDeployConfig,
      receiptsDir: TEMP_PATH,
    },
    {},
    warpCoreConfig,
  );

  const combinedWarpCorePath = getWarpCoreConfigPath('ETH', [
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  ]);

  return {
    chain2DomainId: chain2DomainId.toString(),
    chain3DomainId: chain3DomainId.toString(),
    warpConfigPath,
    configToExtend,
    context,
    combinedWarpCorePath,
  };
}
