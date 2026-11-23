import { ethers } from 'ethers';

import { ModuleType, OnchainHookType } from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  assert,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

import { readOnchain } from '../utils/rpcErrors.js';

export interface WormholeChainConfig {
  core: string;
  wormholeChainId: number;
  router: string;
}

export interface WormholeRouterReader {
  hookType(): Promise<number>;
  localDomain(): Promise<number>;
  moduleType(): Promise<number>;
  remoteRouterConfigs(
    domain: number,
  ): Promise<{ remoteWormholeChainId: number }>;
  routers(domain: number): Promise<string>;
  wormholeChainId(): Promise<number>;
  wormholeCoreBridge(): Promise<string>;
}

export type WormholeRouterConnector = (
  router: string,
  domain: number,
) => WormholeRouterReader;

interface WormholeRouterState extends WormholeChainConfig {
  remoteWormholeChainId: number;
  remoteRouter: string;
}

function assertAddress(address: string, label: string): void {
  assert(
    ethers.utils.isAddress(address) && address !== ethers.constants.AddressZero,
    `${label} is not a non-zero EVM address`,
  );
}

async function readRouterState(
  router: string,
  localDomain: number,
  remoteDomain: number,
  connect: WormholeRouterConnector,
): Promise<WormholeRouterState> {
  assertAddress(router, `Wormhole router for domain ${localDomain}`);
  const contract = connect(router, localDomain);
  const [
    core,
    actualLocalDomain,
    wormholeChainId,
    hookType,
    moduleType,
    remoteRouter,
    { remoteWormholeChainId },
  ] = await readOnchain(() =>
    Promise.all([
      contract.wormholeCoreBridge(),
      contract.localDomain(),
      contract.wormholeChainId(),
      contract.hookType(),
      contract.moduleType(),
      contract.routers(remoteDomain),
      contract.remoteRouterConfigs(remoteDomain),
    ]),
  );

  assert(
    actualLocalDomain === localDomain,
    `Wormhole router ${router} reports Hyperlane domain ${actualLocalDomain}; expected ${localDomain}`,
  );
  assert(
    hookType === OnchainHookType.WORMHOLE,
    `Contract ${router} on domain ${localDomain} is not a Wormhole hook`,
  );
  assert(
    moduleType === ModuleType.CCIP_READ,
    `Contract ${router} on domain ${localDomain} is not a supported Wormhole ISM`,
  );
  assertAddress(core, `Wormhole Core for Wormhole router ${router}`);
  assert(
    wormholeChainId > 0,
    `Wormhole router ${router} reports invalid Wormhole chain ID ${wormholeChainId}`,
  );
  assert(
    remoteWormholeChainId > 0 && remoteWormholeChainId !== wormholeChainId,
    `Wormhole router ${router} reports invalid remote Wormhole chain ID ${remoteWormholeChainId} for Hyperlane domain ${remoteDomain}`,
  );
  const remoteRouterAddress = bytes32ToAddress(remoteRouter);
  assert(
    addressToBytes32(remoteRouterAddress).toLowerCase() ===
      remoteRouter.toLowerCase(),
    `Wormhole router ${router} has a non-canonical peer for Hyperlane domain ${remoteDomain}`,
  );
  assertAddress(
    remoteRouterAddress,
    `Wormhole peer for ${localDomain} -> ${remoteDomain}`,
  );

  return {
    core,
    wormholeChainId,
    router,
    remoteWormholeChainId,
    remoteRouter: remoteRouterAddress,
  };
}

/**
 * Resolves a Wormhole pathway from the CCIP-read sender and the two Hyperlane
 * domains. Both contracts must identify themselves as Wormhole hook/ISMs and
 * have reciprocal router and Wormhole chain ID enrollment. No trusted
 * deployment-address configuration is required by the offchain server.
 */
export async function resolveWormholeRoutes(
  originDomain: number,
  destinationDomain: number,
  requestRouter: string,
  connect: WormholeRouterConnector,
): Promise<{
  origin: WormholeChainConfig;
  destination: WormholeChainConfig;
}> {
  const destination = await readRouterState(
    requestRouter,
    destinationDomain,
    originDomain,
    connect,
  );

  const origin = await readRouterState(
    destination.remoteRouter,
    originDomain,
    destinationDomain,
    connect,
  );
  assert(
    origin.remoteRouter.toLowerCase() === requestRouter.toLowerCase(),
    `Wormhole routers are not reciprocally enrolled for ${originDomain} -> ${destinationDomain}`,
  );
  assert(
    destination.remoteWormholeChainId === origin.wormholeChainId &&
      origin.remoteWormholeChainId === destination.wormholeChainId,
    `Wormhole chain IDs are inconsistent for ${originDomain} -> ${destinationDomain}`,
  );

  return {
    origin: {
      core: origin.core,
      wormholeChainId: origin.wormholeChainId,
      router: origin.router,
    },
    destination: {
      core: destination.core,
      wormholeChainId: destination.wormholeChainId,
      router: destination.router,
    },
  };
}
