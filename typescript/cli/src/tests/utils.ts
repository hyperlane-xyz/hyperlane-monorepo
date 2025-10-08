import * as chai from 'chai';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  TokenStandard,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { isObjEmpty } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_TOKEN_SYMBOL,
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
