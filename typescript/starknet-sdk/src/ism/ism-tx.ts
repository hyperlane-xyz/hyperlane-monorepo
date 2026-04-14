import { type RpcProvider } from 'starknet';

import { type AltVM } from '@hyperlane-xyz/provider-sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateMerkleRootMultisigIsmTx(
  req: AltVM.ReqCreateMerkleRootMultisigIsm,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
    constructorArgs: [
      normalizeStarknetAddressSafe(req.signer),
      req.validators.map((validator) => addressToBytes32(validator)),
      req.threshold,
    ],
  };
}

export function getCreateMessageIdMultisigIsmTx(
  req: AltVM.ReqCreateMessageIdMultisigIsm,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MESSAGE_ID_MULTISIG_ISM,
    constructorArgs: [
      normalizeStarknetAddressSafe(req.signer),
      req.validators.map((validator) => addressToBytes32(validator)),
      req.threshold,
    ],
  };
}

export function getCreateRoutingIsmTx(
  req: AltVM.ReqCreateRoutingIsm,
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.ROUTING_ISM,
    constructorArgs: [normalizeStarknetAddressSafe(req.signer)],
  };
}

export async function getSetRoutingIsmRouteTx(
  provider: RpcProvider,
  req: AltVM.ReqSetRoutingIsmRoute,
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    req.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'set', [
    req.route.domainId,
    normalizeStarknetAddressSafe(req.route.ismAddress),
  ]);
}

export async function getRemoveRoutingIsmRouteTx(
  provider: RpcProvider,
  req: AltVM.ReqRemoveRoutingIsmRoute,
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    req.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'remove', [req.domainId]);
}

export async function getSetRoutingIsmOwnerTx(
  provider: RpcProvider,
  req: AltVM.ReqSetRoutingIsmOwner,
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    req.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'transfer_ownership', [
    normalizeStarknetAddressSafe(req.newOwner),
  ]);
}

export function getCreateNoopIsmTx(): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.NOOP_ISM,
    constructorArgs: [],
  };
}
