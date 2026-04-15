import { type RpcProvider } from 'starknet';

import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  StarknetContractName,
  getStarknetContract,
  normalizeStarknetAddressSafe,
  populateInvokeTx,
} from '../contracts.js';
import { type StarknetAnnotatedTx } from '../types.js';

export function getCreateMerkleRootMultisigIsmTx(
  signer: string,
  config: {
    validators: string[];
    threshold: number;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MERKLE_ROOT_MULTISIG_ISM,
    constructorArgs: [
      normalizeStarknetAddressSafe(signer),
      config.validators.map((validator) => addressToBytes32(validator)),
      config.threshold,
    ],
  };
}

export function getCreateMessageIdMultisigIsmTx(
  signer: string,
  config: {
    validators: string[];
    threshold: number;
  },
): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.MESSAGE_ID_MULTISIG_ISM,
    constructorArgs: [
      normalizeStarknetAddressSafe(signer),
      config.validators.map((validator) => addressToBytes32(validator)),
      config.threshold,
    ],
  };
}

export function getCreateRoutingIsmTx(signer: string): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.ROUTING_ISM,
    constructorArgs: [normalizeStarknetAddressSafe(signer)],
  };
}

export async function getSetRoutingIsmRouteTx(
  provider: RpcProvider,
  config: {
    ismAddress: string;
    route: { domainId: number; ismAddress: string };
  },
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    config.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'set', [
    config.route.domainId,
    normalizeStarknetAddressSafe(config.route.ismAddress),
  ]);
}

export async function getRemoveRoutingIsmRouteTx(
  provider: RpcProvider,
  config: {
    ismAddress: string;
    domainId: number;
  },
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    config.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'remove', [config.domainId]);
}

export async function getSetRoutingIsmOwnerTx(
  provider: RpcProvider,
  config: {
    ismAddress: string;
    newOwner: string;
  },
): Promise<StarknetAnnotatedTx> {
  const routing = getStarknetContract(
    StarknetContractName.ROUTING_ISM,
    config.ismAddress,
    provider,
  );
  return populateInvokeTx(routing, 'transfer_ownership', [
    normalizeStarknetAddressSafe(config.newOwner),
  ]);
}

export function getCreateNoopIsmTx(): StarknetAnnotatedTx {
  return {
    kind: 'deploy',
    contractName: StarknetContractName.NOOP_ISM,
    constructorArgs: [],
  };
}
