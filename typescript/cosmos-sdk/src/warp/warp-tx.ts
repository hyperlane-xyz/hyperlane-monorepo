import { type ArtifactDeployed } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type RawWarpArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  assert,
  eqAddressCosmos,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import {
  type MsgCreateCollateralTokenEncodeObject,
  type MsgCreateSyntheticTokenEncodeObject,
  type MsgEnrollRemoteRouterEncodeObject,
  type MsgSetTokenEncodeObject,
  type MsgUnrollRemoteRouterEncodeObject,
} from '../hyperlane/warp/messages.js';
import { COSMOS_MODULE_MESSAGE_REGISTRY as MessageRegistry } from '../registry.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

export function getCreateCollateralTokenTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
    collateralDenom: string;
  },
): MsgCreateCollateralTokenEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgCreateCollateralToken.proto.type,
    value: MessageRegistry.MsgCreateCollateralToken.proto.converter.create({
      owner: fromAddress,
      origin_mailbox: config.mailboxAddress,
      origin_denom: config.collateralDenom,
    }),
  };
}

export function getCreateSyntheticTokenTx(
  fromAddress: string,
  config: {
    mailboxAddress: string;
  },
): MsgCreateSyntheticTokenEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgCreateSyntheticToken.proto.type,
    value: MessageRegistry.MsgCreateSyntheticToken.proto.converter.create({
      owner: fromAddress,
      origin_mailbox: config.mailboxAddress,
    }),
  };
}

export function getSetTokenOwnerTx(
  fromAddress: string,
  config: {
    tokenAddress: string;
    newOwner?: string;
  },
): MsgSetTokenEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgSetToken.proto.type,
    value: MessageRegistry.MsgSetToken.proto.converter.create({
      owner: fromAddress,
      token_id: config.tokenAddress,
      new_owner: config.newOwner ?? '',
      renounce_ownership: !config.newOwner,
    }),
  };
}

// Note: Cosmos does not support resetting ISM to default yet (validation will be removed when bug is fixed)
export function getSetTokenIsmTx(
  fromAddress: string,
  config: {
    tokenAddress: string;
    ismAddress?: string;
  },
): MsgSetTokenEncodeObject {
  assert(
    config.ismAddress && !isZeroishAddress(config.ismAddress),
    'Cosmos does not support resetting the ism to the default one yet',
  );

  return {
    typeUrl: MessageRegistry.MsgSetToken.proto.type,
    value: MessageRegistry.MsgSetToken.proto.converter.create({
      owner: fromAddress,
      token_id: config.tokenAddress,
      ism_id: config.ismAddress ?? '',
    }),
  };
}

export function getEnrollRemoteRouterTx(
  fromAddress: string,
  config: {
    tokenAddress: string;
    remoteDomainId: number;
    remoteRouterAddress: string;
    gas: string;
  },
): MsgEnrollRemoteRouterEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgEnrollRemoteRouter.proto.type,
    value: MessageRegistry.MsgEnrollRemoteRouter.proto.converter.create({
      owner: fromAddress,
      token_id: config.tokenAddress,
      remote_router: {
        receiver_domain: config.remoteDomainId,
        receiver_contract: config.remoteRouterAddress,
        gas: config.gas,
      },
    }),
  };
}

export function getUnenrollRemoteRouterTx(
  fromAddress: string,
  config: {
    tokenAddress: string;
    remoteDomainId: number;
  },
): MsgUnrollRemoteRouterEncodeObject {
  return {
    typeUrl: MessageRegistry.MsgUnrollRemoteRouter.proto.type,
    value: MessageRegistry.MsgUnrollRemoteRouter.proto.converter.create({
      owner: fromAddress,
      token_id: config.tokenAddress,
      receiver_domain: config.remoteDomainId,
    }),
  };
}

export function getWarpTokenUpdateTxs<TConfig extends RawWarpArtifactConfig>(
  expectedArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
  currentArtifactState: ArtifactDeployed<TConfig, DeployedWarpAddress>,
  signerAddress: string,
): AnnotatedEncodeObject[] {
  const { config: expectedConfig, deployed } = expectedArtifactState;
  const { config: currentConfig } = currentArtifactState;
  const updateTxs: AnnotatedEncodeObject[] = [];

  // Update ISM if changed
  const currentIsm = currentConfig.interchainSecurityModule?.deployed.address;
  const newIsm = expectedConfig.interchainSecurityModule?.deployed.address;

  if (!eqAddressCosmos(currentIsm ?? '', newIsm ?? '')) {
    if (newIsm) {
      const setIsmTx = getSetTokenIsmTx(signerAddress, {
        tokenAddress: deployed.address,
        ismAddress: newIsm,
      });
      updateTxs.push({
        ...setIsmTx,
        annotation: 'Updating token ISM',
      });
    }
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
      const unenrollTx = getUnenrollRemoteRouterTx(signerAddress, {
        tokenAddress: deployed.address,
        remoteDomainId: domainId,
      });
      updateTxs.push({
        ...unenrollTx,
        annotation: `Unenrolling router for domain ${domainId}`,
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
      !eqAddressCosmos(currentRouter.address, remoteRouter.address) ||
      currentGas !== gas;

    if (needsUpdate) {
      const enrollTx = getEnrollRemoteRouterTx(signerAddress, {
        tokenAddress: deployed.address,
        remoteDomainId: domainId,
        remoteRouterAddress: remoteRouter.address,
        gas: gas,
      });
      updateTxs.push({
        ...enrollTx,
        annotation: `Enrolling/updating router for domain ${domainId}`,
      });
    }
  }

  // Update owner if changed (must be done last, after all other updates)
  if (!eqAddressCosmos(currentConfig.owner, expectedConfig.owner)) {
    const setOwnerTx = getSetTokenOwnerTx(signerAddress, {
      tokenAddress: deployed.address,
      newOwner: expectedConfig.owner,
    });
    updateTxs.push({
      ...setOwnerTx,
      annotation: 'Transferring token ownership',
    });
  }

  return updateTxs;
}
