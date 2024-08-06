import {
  ChainMap,
  IsmType,
  MultisigIsmConfig,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

// the addresses here must line up with the e2e test's validator addresses
// Validators are anvil accounts 4-7
export const chainToValidator: Record<TestChainName, Address> = {
  test1: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  test2: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  test3: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  test4: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
};

export const merkleRootMultisig = (validatorKey: string): MultisigIsmConfig => {
  return {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators: [validatorKey],
    threshold: 1,
  };
};

export const messageIdMultisig = (validatorKey: string): MultisigIsmConfig => {
  return {
    type: IsmType.MESSAGE_ID_MULTISIG,
    validators: [validatorKey],
    threshold: 1,
  };
};

// the addresses here must line up with the e2e test's validator addresses
export const multisigIsm: ChainMap<MultisigIsmConfig> = {
  // Validators are anvil accounts 4-7
  test1: messageIdMultisig(chainToValidator['test1']),
  test2: merkleRootMultisig(chainToValidator['test2']),
  test3: messageIdMultisig(chainToValidator['test3']),
  test4: messageIdMultisig(chainToValidator['test4']),
};
