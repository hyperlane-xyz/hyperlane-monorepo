import { ethers } from 'ethers';

import { ModuleType, OnchainHookType } from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  assert,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

export interface LayerZeroChainConfig {
  mailbox: string;
  endpoint: string;
  layerZeroDomainId: number;
  router: string;
}

export interface LayerZeroRouterReader {
  endpoint(): Promise<string>;
  hookType(): Promise<number>;
  localDomain(): Promise<number>;
  localEid(): Promise<number>;
  mailbox(): Promise<string>;
  moduleType(): Promise<number>;
  remoteConfigs(domain: number): Promise<number>;
  routers(domain: number): Promise<string>;
}

export type LayerZeroRouterConnector = (
  router: string,
  domain: number,
) => LayerZeroRouterReader;

interface LayerZeroRouterState extends LayerZeroChainConfig {
  moduleType: number;
  remoteLayerZeroDomainId: number;
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
  connect: LayerZeroRouterConnector,
): Promise<LayerZeroRouterState> {
  assertAddress(router, `LayerZero router for domain ${localDomain}`);
  const contract = connect(router, localDomain);
  const [
    mailbox,
    endpoint,
    actualLocalDomain,
    layerZeroDomainId,
    hookType,
    moduleType,
    remoteRouter,
    remoteLayerZeroDomainId,
  ] = await Promise.all([
    contract.mailbox(),
    contract.endpoint(),
    contract.localDomain(),
    contract.localEid(),
    contract.hookType(),
    contract.moduleType(),
    contract.routers(remoteDomain),
    contract.remoteConfigs(remoteDomain),
  ]);

  assert(
    actualLocalDomain === localDomain,
    `LayerZero router ${router} reports Hyperlane domain ${actualLocalDomain}; expected ${localDomain}`,
  );
  assert(
    hookType === OnchainHookType.LAYER_ZERO,
    `Contract ${router} on domain ${localDomain} is not a LayerZero hook`,
  );
  assert(
    moduleType === ModuleType.NULL || moduleType === ModuleType.CCIP_READ,
    `Contract ${router} on domain ${localDomain} is not a supported LayerZero ISM`,
  );
  assertAddress(mailbox, `Mailbox for LayerZero router ${router}`);
  assertAddress(endpoint, `Endpoint for LayerZero router ${router}`);
  assert(
    layerZeroDomainId > 0,
    `LayerZero router ${router} reports invalid local domain ID ${layerZeroDomainId}`,
  );
  assert(
    remoteLayerZeroDomainId > 0 &&
      remoteLayerZeroDomainId !== layerZeroDomainId,
    `LayerZero router ${router} reports invalid remote domain ID ${remoteLayerZeroDomainId}`,
  );
  const remoteRouterAddress = bytes32ToAddress(remoteRouter);
  assert(
    addressToBytes32(remoteRouterAddress).toLowerCase() ===
      remoteRouter.toLowerCase(),
    `LayerZero router ${router} has a non-canonical peer for Hyperlane domain ${remoteDomain}`,
  );
  assertAddress(
    remoteRouterAddress,
    `LayerZero peer for ${localDomain} -> ${remoteDomain}`,
  );

  return {
    mailbox,
    endpoint,
    layerZeroDomainId,
    router,
    moduleType,
    remoteLayerZeroDomainId,
    remoteRouter: remoteRouterAddress,
  };
}

/**
 * Resolves a LayerZero pathway from the CCIP-read sender and the two Hyperlane
 * domains. Both contracts must identify themselves as LayerZero hook/ISMs and
 * have reciprocal router and EID enrollment. No trusted deployment-address
 * configuration is required by the offchain server.
 */
export async function resolveLayerZeroRoutes(
  originDomain: number,
  destinationDomain: number,
  requestRouter: string,
  connect: LayerZeroRouterConnector,
): Promise<{
  origin: LayerZeroChainConfig;
  destination: LayerZeroChainConfig;
}> {
  const destination = await readRouterState(
    requestRouter,
    destinationDomain,
    originDomain,
    connect,
  );
  assert(
    destination.moduleType === ModuleType.CCIP_READ,
    `LayerZero CCIP sender ${requestRouter} is not a CCIP-read ISM`,
  );

  const origin = await readRouterState(
    destination.remoteRouter,
    originDomain,
    destinationDomain,
    connect,
  );
  assert(
    origin.remoteRouter.toLowerCase() === requestRouter.toLowerCase(),
    `LayerZero routers are not reciprocally enrolled for ${originDomain} -> ${destinationDomain}`,
  );
  assert(
    destination.remoteLayerZeroDomainId === origin.layerZeroDomainId &&
      origin.remoteLayerZeroDomainId === destination.layerZeroDomainId,
    `LayerZero domain IDs are inconsistent for ${originDomain} -> ${destinationDomain}`,
  );

  return {
    origin: {
      mailbox: origin.mailbox,
      endpoint: origin.endpoint,
      layerZeroDomainId: origin.layerZeroDomainId,
      router: origin.router,
    },
    destination: {
      mailbox: destination.mailbox,
      endpoint: destination.endpoint,
      layerZeroDomainId: destination.layerZeroDomainId,
      router: destination.router,
    },
  };
}
