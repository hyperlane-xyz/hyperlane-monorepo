import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';
import {
  TransactionManifest,
  address,
  decimal,
  enumeration,
  str,
  u8,
  u32,
} from '@radixdlt/radix-engine-toolkit';

import { ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedWarpAddress,
  RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  eqAddressRadix,
  isZeroishAddress,
  strip0x,
} from '@hyperlane-xyz/utils';

import {
  getComponentOwnershipInfo,
  getRadixComponentDetails,
} from '../utils/base-query.js';
import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  INSTRUCTIONS,
  RADIX_COMPONENT_NAMES,
} from '../utils/types.js';
import { bytes } from '../utils/utils.js';

export async function getCreateCollateralTokenTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailbox,
    originDenom,
  }: {
    mailbox: string;
    originDenom: string;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    RADIX_COMPONENT_NAMES.HYP_TOKEN,
    INSTRUCTIONS.INSTANTIATE,
    [enumeration(0, address(originDenom)), address(mailbox)],
  );
}

export async function getCreateSyntheticTokenTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    mailbox,
    name,
    symbol,
    divisibility,
  }: {
    mailbox: string;
    name: string;
    symbol: string;
    divisibility: number;
  },
): Promise<TransactionManifest> {
  return base.createCallFunctionManifest(
    fromAddress,
    base.getHyperlanePackageDefAddress(),
    RADIX_COMPONENT_NAMES.HYP_TOKEN,
    INSTRUCTIONS.INSTANTIATE,
    [
      enumeration(1, str(name), str(symbol), str(''), u8(divisibility)),
      address(mailbox),
    ],
  );
}

export async function getSetTokenOwnerTx(
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  fromAddress: string,
  {
    tokenAddress,
    newOwner,
  }: {
    tokenAddress: string;
    newOwner: string;
  },
): Promise<TransactionManifest> {
  const tokenDetails = await getRadixComponentDetails(
    gateway,
    tokenAddress,
    RADIX_COMPONENT_NAMES.HYP_TOKEN,
  );

  const ownershipInfo = getComponentOwnershipInfo(tokenAddress, tokenDetails);
  const resourceAddress =
    ownershipInfo.rule.access_rule.proof_rule.requirement.resource;

  return base.transfer({
    from_address: fromAddress,
    to_address: newOwner,
    resource_address: resourceAddress,
    amount: '1',
  });
}

export async function getSetTokenIsmTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    ismAddress,
  }: {
    tokenAddress: string;
    ismAddress?: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'set_ism',
    [
      // Set or unset the ism based on the input value
      // undefined or zero address → unset (use default ISM)
      ismAddress && !isZeroishAddress(ismAddress)
        ? enumeration(1, address(ismAddress))
        : enumeration(0),
    ],
  );
}

export async function getEnrollRemoteRouterTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    remoteDomainId,
    remoteRouterAddress,
    destinationGas,
  }: {
    tokenAddress: string;
    remoteDomainId: number;
    remoteRouterAddress: string;
    destinationGas: string;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'enroll_remote_router',
    [
      u32(remoteDomainId),
      bytes(strip0x(remoteRouterAddress)),
      decimal(destinationGas),
    ],
  );
}

export async function getUnenrollRemoteRouterTx(
  base: Readonly<RadixBase>,
  fromAddress: string,
  {
    tokenAddress,
    remoteDomainId,
  }: {
    tokenAddress: string;
    remoteDomainId: number;
  },
): Promise<TransactionManifest> {
  return base.createCallMethodManifestWithOwner(
    fromAddress,
    tokenAddress,
    'unroll_remote_router',
    [u32(remoteDomainId)],
  );
}

/**
 * Generates update transactions for a warp token by comparing current on-chain state
 * with desired configuration. Returns transactions for ISM updates, router enrollment/unenrollment,
 * and ownership transfer (always last).
 *
 * @param expectedArtifactState The desired warp token configuration with deployment address
 * @param reader Reader instance to fetch current on-chain state
 * @param base RadixBase instance for transaction building
 * @param gateway GatewayApiClient for owner queries
 * @param signerAddress Address of the transaction signer
 * @returns Array of transactions to execute in order
 */
export async function getWarpTokenUpdateTxs<
  TConfig extends RawWarpArtifactConfig,
>(
  expectedArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
  currentArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
  base: Readonly<RadixBase>,
  gateway: Readonly<GatewayApiClient>,
  signerAddress: string,
): Promise<AnnotatedRadixTransaction[]> {
  const { config: expectedConfig, deployed } = expectedArtifactState;
  const { config: currentConfig } = currentArtifactState;
  const updateTxs: AnnotatedRadixTransaction[] = [];

  // Update ISM if changed
  const currentIsm = currentConfig.interchainSecurityModule?.deployed.address;
  const newIsm = expectedConfig.interchainSecurityModule?.deployed.address;

  if (!eqAddressRadix(currentIsm ?? '', newIsm ?? '')) {
    const setIsmTx = await getSetTokenIsmTx(base, signerAddress, {
      tokenAddress: deployed.address,
      ismAddress: newIsm,
    });
    updateTxs.push({
      annotation: 'Updating token ISM',
      networkId: base.getNetworkId(),
      manifest: setIsmTx,
    });
  }

  // Get current and desired remote routers
  const currentRouters = new Set(
    Object.keys(currentConfig.remoteRouters).map((k) => parseInt(k)),
  );
  const desiredRouters = new Set(
    Object.keys(expectedConfig.remoteRouters).map((k) => parseInt(k)),
  );

  // Unenroll removed routers
  for (const domainId of currentRouters) {
    if (!desiredRouters.has(domainId)) {
      const unenrollTx = await getUnenrollRemoteRouterTx(base, signerAddress, {
        tokenAddress: deployed.address,
        remoteDomainId: domainId,
      });
      updateTxs.push({
        annotation: `Unenrolling router for domain ${domainId}`,
        networkId: base.getNetworkId(),
        manifest: unenrollTx,
      });
    }
  }

  // Enroll or update routers
  for (const [domainIdStr, remoteRouter] of Object.entries(
    expectedConfig.remoteRouters,
  )) {
    const domainId = parseInt(domainIdStr);
    const gas = expectedConfig.destinationGas[domainId] || '0';
    const currentRouter = currentConfig.remoteRouters[domainId];
    const currentGas = currentConfig.destinationGas[domainId] || '0';

    const needsUpdate =
      !currentRouter ||
      !eqAddressRadix(currentRouter.address, remoteRouter.address) ||
      currentGas !== gas;

    if (needsUpdate) {
      const enrollTx = await getEnrollRemoteRouterTx(base, signerAddress, {
        tokenAddress: deployed.address,
        remoteDomainId: domainId,
        remoteRouterAddress: remoteRouter.address,
        destinationGas: gas,
      });
      updateTxs.push({
        annotation: `Enrolling/updating router for domain ${domainId}`,
        networkId: base.getNetworkId(),
        manifest: enrollTx,
      });
    }
  }

  // Owner transfer must be last transaction as the current owner executes all updates
  if (!eqAddressRadix(currentConfig.owner, expectedConfig.owner)) {
    const setOwnerTx = await getSetTokenOwnerTx(base, gateway, signerAddress, {
      tokenAddress: deployed.address,
      newOwner: expectedConfig.owner,
    });
    updateTxs.push({
      annotation: 'Setting new token owner',
      networkId: base.getNetworkId(),
      manifest: setOwnerTx,
    });
  }

  return updateTxs;
}
