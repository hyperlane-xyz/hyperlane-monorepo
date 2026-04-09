import * as chai from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainName,
  TokenStandard,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, isObjEmpty } from '@hyperlane-xyz/utils';

import {
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

/**
 * Assert that `expectedRouter` is enrolled as a CC router under `domain`
 * in the given cross-collateral routers map.
 */
export function expectCcRouterEnrolled(
  ccRouters: Record<number, Set<string>>,
  domain: number,
  expectedRouter: string,
  message?: string,
): void {
  const canonical = addressToBytes32(expectedRouter).toLowerCase();
  const enrolled = [...(ccRouters[domain] ?? [])].some(
    (r) => r.toLowerCase() === canonical,
  );
  expect(
    enrolled,
    message ?? `Expected CC router ${expectedRouter} on domain ${domain}`,
  ).to.be.true;
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
