import {
  decodeMultisigIsmAccessControlAccount,
  decodeMultisigIsmDomainDataAccount,
} from '../accounts/multisig-ism-message-id.js';
import { decodeTestIsmStorageAccount } from '../accounts/test-ism.js';
import {
  decodeInterchainSecurityModuleInterfaceInstruction,
  decodeMultisigIsmInterfaceInstruction,
} from '../instructions/interfaces.js';
import { decodeMultisigIsmMessageIdProgramInstruction } from '../instructions/multisig-ism-message-id.js';

export const decodeIsmInstruction = {
  interchainSecurityModule: decodeInterchainSecurityModuleInterfaceInstruction,
  multisigInterface: decodeMultisigIsmInterfaceInstruction,
  multisigProgram: decodeMultisigIsmMessageIdProgramInstruction,
};

export const decodeIsmAccount = {
  multisigAccessControl: decodeMultisigIsmAccessControlAccount,
  multisigDomainData: decodeMultisigIsmDomainDataAccount,
  testIsmStorage: decodeTestIsmStorageAccount,
};
