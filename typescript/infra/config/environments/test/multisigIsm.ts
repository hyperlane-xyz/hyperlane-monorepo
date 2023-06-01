import { ChainMap, ModuleType, MultisigIsmConfig } from '@hyperlane-xyz/sdk';

// the addresses here must line up with the e2e test's validator addresses
export const multisigIsm: ChainMap<MultisigIsmConfig> = {
  // Validators are anvil accounts 4-6
  test1: {
    type: ModuleType.LEGACY_MULTISIG,
    validators: ['0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'],
    threshold: 1,
  },
  test2: {
    type: ModuleType.MERKLE_ROOT_MULTISIG,
    validators: ['0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'],
    threshold: 1,
  },
  test3: {
    type: ModuleType.MESSAGE_ID_MULTISIG,
    validators: ['0x976EA74026E726554dB657fA54763abd0C3a0aa9'],
    threshold: 1,
  },
};
