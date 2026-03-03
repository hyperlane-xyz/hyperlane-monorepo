import { PROGRAM_INSTRUCTION_DISCRIMINATOR } from '../constants.js';
import { ByteCursor, concatBytes } from '../codecs/binary.js';
import {
  decodeHandleInstruction,
  decodeVerifyInstruction,
  encodeHandleInstruction,
  encodeVerifyInstruction,
  type HandleInstruction,
  type VerifyInstruction,
} from '../codecs/shared.js';
import { ReadonlyUint8Array } from '@solana/kit';

// Kept verbose for grep/disambiguation across similarly named interface discriminators.
export const INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS = {
  type: new Uint8Array([105, 97, 97, 88, 63, 124, 106, 18]),
  verify: new Uint8Array([243, 53, 214, 0, 208, 18, 231, 67]),
  verifyAccountMetas: new Uint8Array([200, 65, 157, 12, 89, 255, 131, 216]),
} as const;

export const MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS = {
  interchainSecurityModule: new Uint8Array([45, 18, 245, 87, 234, 46, 246, 15]),
  interchainSecurityModuleAccountMetas: new Uint8Array([
    190, 214, 218, 129, 67, 97, 4, 76,
  ]),
  handle: new Uint8Array([33, 210, 5, 66, 196, 212, 239, 142]),
  handleAccountMetas: new Uint8Array([194, 141, 30, 82, 241, 41, 169, 52]),
} as const;

export const MULTISIG_ISM_INTERFACE_DISCRIMINATORS = {
  validatorsAndThreshold: new Uint8Array([82, 96, 5, 220, 241, 173, 13, 50]),
  validatorsAndThresholdAccountMetas: new Uint8Array([
    113, 7, 132, 85, 239, 247, 157, 204,
  ]),
} as const;

export type InterchainSecurityModuleInterfaceInstruction =
  | { type: 'type' }
  | { type: 'verify'; data: VerifyInstruction }
  | { type: 'verifyAccountMetas'; data: VerifyInstruction };

export type MessageRecipientInterfaceInstruction =
  | { type: 'interchainSecurityModule' }
  | { type: 'interchainSecurityModuleAccountMetas' }
  | { type: 'handle'; data: HandleInstruction }
  | { type: 'handleAccountMetas'; data: HandleInstruction };

export type MultisigIsmInterfaceInstruction =
  | { type: 'validatorsAndThreshold'; message: Uint8Array }
  | { type: 'validatorsAndThresholdAccountMetas'; message: Uint8Array };

export function isProgramInstructionDiscriminator(data: Uint8Array): boolean {
  if (data.length < PROGRAM_INSTRUCTION_DISCRIMINATOR.length) return false;
  for (let i = 0; i < PROGRAM_INSTRUCTION_DISCRIMINATOR.length; i += 1) {
    if (data[i] !== PROGRAM_INSTRUCTION_DISCRIMINATOR[i]) return false;
  }
  return true;
}

export function encodeInterchainSecurityModuleInterfaceInstruction(
  instruction: InterchainSecurityModuleInterfaceInstruction,
): ReadonlyUint8Array {
  switch (instruction.type) {
    case 'type':
      return INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.type;
    case 'verify':
      return concatBytes(
        INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.verify,
        encodeVerifyInstruction(instruction.data),
      );
    case 'verifyAccountMetas':
      return concatBytes(
        INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.verifyAccountMetas,
        encodeVerifyInstruction(instruction.data),
      );
  }
}

export function decodeInterchainSecurityModuleInterfaceInstruction(
  data: Uint8Array,
): InterchainSecurityModuleInterfaceInstruction | null {
  if (data.length < 8) return null;
  const discriminator = data.slice(0, 8);
  const payload = new ByteCursor(data.slice(8));

  if (
    isEqual(
      discriminator,
      INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.type,
    )
  ) {
    return { type: 'type' };
  }
  if (
    isEqual(
      discriminator,
      INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.verify,
    )
  ) {
    return { type: 'verify', data: decodeVerifyInstruction(payload) };
  }
  if (
    isEqual(
      discriminator,
      INTERCHAIN_SECURITY_MODULE_INTERFACE_DISCRIMINATORS.verifyAccountMetas,
    )
  ) {
    return {
      type: 'verifyAccountMetas',
      data: decodeVerifyInstruction(payload),
    };
  }
  return null;
}

export function encodeMessageRecipientInterfaceInstruction(
  instruction: MessageRecipientInterfaceInstruction,
): ReadonlyUint8Array {
  switch (instruction.type) {
    case 'interchainSecurityModule':
      return MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.interchainSecurityModule;
    case 'interchainSecurityModuleAccountMetas':
      return MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.interchainSecurityModuleAccountMetas;
    case 'handle':
      return concatBytes(
        MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.handle,
        encodeHandleInstruction(instruction.data),
      );
    case 'handleAccountMetas':
      return concatBytes(
        MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.handleAccountMetas,
        encodeHandleInstruction(instruction.data),
      );
  }
}

export function decodeMessageRecipientInterfaceInstruction(
  data: Uint8Array,
): MessageRecipientInterfaceInstruction | null {
  if (data.length < 8) return null;
  const discriminator = data.slice(0, 8);
  const payload = new ByteCursor(data.slice(8));

  if (
    isEqual(
      discriminator,
      MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.interchainSecurityModule,
    )
  ) {
    return { type: 'interchainSecurityModule' };
  }
  if (
    isEqual(
      discriminator,
      MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.interchainSecurityModuleAccountMetas,
    )
  ) {
    return { type: 'interchainSecurityModuleAccountMetas' };
  }
  if (
    isEqual(discriminator, MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.handle)
  ) {
    return { type: 'handle', data: decodeHandleInstruction(payload) };
  }
  if (
    isEqual(
      discriminator,
      MESSAGE_RECIPIENT_INTERFACE_DISCRIMINATORS.handleAccountMetas,
    )
  ) {
    return {
      type: 'handleAccountMetas',
      data: decodeHandleInstruction(payload),
    };
  }
  return null;
}

export function encodeMultisigIsmInterfaceInstruction(
  instruction: MultisigIsmInterfaceInstruction,
): ReadonlyUint8Array {
  switch (instruction.type) {
    case 'validatorsAndThreshold':
      return concatBytes(
        MULTISIG_ISM_INTERFACE_DISCRIMINATORS.validatorsAndThreshold,
        instruction.message,
      );
    case 'validatorsAndThresholdAccountMetas':
      return concatBytes(
        MULTISIG_ISM_INTERFACE_DISCRIMINATORS.validatorsAndThresholdAccountMetas,
        instruction.message,
      );
  }
}

export function decodeMultisigIsmInterfaceInstruction(
  data: Uint8Array,
): MultisigIsmInterfaceInstruction | null {
  if (data.length < 8) return null;
  const discriminator = data.slice(0, 8);
  const message = data.slice(8);

  if (
    isEqual(
      discriminator,
      MULTISIG_ISM_INTERFACE_DISCRIMINATORS.validatorsAndThreshold,
    )
  ) {
    return { type: 'validatorsAndThreshold', message };
  }
  if (
    isEqual(
      discriminator,
      MULTISIG_ISM_INTERFACE_DISCRIMINATORS.validatorsAndThresholdAccountMetas,
    )
  ) {
    return { type: 'validatorsAndThresholdAccountMetas', message };
  }
  return null;
}

function isEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
