import { strip0x } from '@hyperlane-xyz/utils';

import { fillArray, fromAleoAddress } from '../utils/helper.js';
import { AleoTransaction } from '../utils/types.js';

export function getCreateTestIsmTx(
  ismManagerProgramId: string,
): AleoTransaction {
  return {
    programName: ismManagerProgramId,
    functionName: 'init_noop',
    priorityFee: 0,
    privateFee: false,
    inputs: [],
  };
}

export function getCreateMessageIdMultisigIsmTx(
  ismManagerProgramId: string,
  config: { validators: string[]; threshold: number },
): AleoTransaction {
  const MAXIMUM_VALIDATORS = 6;

  if (config.validators.length > MAXIMUM_VALIDATORS) {
    throw new Error(`maximum ${MAXIMUM_VALIDATORS} validators allowed`);
  }

  const validators = fillArray(
    config.validators.map((v) => ({
      bytes: [...Buffer.from(strip0x(v), 'hex')].map((b) => `${b}u8`),
    })),
    MAXIMUM_VALIDATORS,
    {
      bytes: Array(20).fill(`0u8`),
    },
  );

  return {
    programName: ismManagerProgramId,
    functionName: 'init_message_id_multisig',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      JSON.stringify(validators).replaceAll('"', ''),
      `${config.validators.length}u8`,
      `${config.threshold}u8`,
    ],
  };
}

export function getCreateRoutingIsmTx(
  ismManagerProgramId: string,
): AleoTransaction {
  return {
    programName: ismManagerProgramId,
    functionName: 'init_domain_routing',
    priorityFee: 0,
    privateFee: false,
    inputs: [],
  };
}

export function getSetRoutingIsmRouteTx(
  ismAddress: string,
  route: { domainId: number; ismAddress: string },
): AleoTransaction {
  const { programId, address } = fromAleoAddress(ismAddress);

  return {
    programName: programId,
    functionName: 'set_domain',
    priorityFee: 0,
    privateFee: false,
    inputs: [
      address,
      `${route.domainId}u32`,
      fromAleoAddress(route.ismAddress).address,
    ],
  };
}

export function getRemoveRoutingIsmRouteTx(
  ismAddress: string,
  domainId: number,
): AleoTransaction {
  const { programId, address } = fromAleoAddress(ismAddress);

  return {
    programName: programId,
    functionName: 'remove_domain',
    priorityFee: 0,
    privateFee: false,
    inputs: [address, `${domainId}u32`],
  };
}

export function getSetRoutingIsmOwnerTx(
  ismAddress: string,
  newOwner: string,
): AleoTransaction {
  const { programId, address } = fromAleoAddress(ismAddress);

  return {
    programName: programId,
    functionName: 'transfer_routing_ism_ownership',
    priorityFee: 0,
    privateFee: false,
    inputs: [address, newOwner],
  };
}
