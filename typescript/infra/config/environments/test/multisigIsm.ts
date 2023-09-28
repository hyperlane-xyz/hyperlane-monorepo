import { ChainMap, ModuleType, MultisigIsmConfig } from '@hyperlane-xyz/sdk';
import { ChainName } from '@hyperlane-xyz/sdk/src';

// the addresses here must line up with the e2e test's validator addresses
// Validators are anvil accounts 4-6
export const chainToValidator: Record<string, string> = {
  test1: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  test2: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  test3: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
};

export const merkleRootMultisig = (chain: ChainName): MultisigIsmConfig => {
  return {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    validators: [chain],
    threshold: 1,
  };
};

export const messageIdMultisig = (chain: ChainName): MultisigIsmConfig => {
  return {
    type: ModuleType.MESSAGE_ID_MULTISIG,
    validators: [chain],
    threshold: 1,
  };
};

// the addresses here must line up with the e2e test's validator addresses
export const multisigIsm: ChainMap<MultisigIsmConfig> = {
  // Validators are anvil accounts 4-6
  test1: messageIdMultisig('test1'),
  test2: merkleRootMultisig('test2'),
  test3: messageIdMultisig('test3'),
};
