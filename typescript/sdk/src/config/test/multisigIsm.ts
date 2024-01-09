import { IsmType, MultisigConfig, MultisigIsmConfig } from '../../ism/types';
import { ChainMap } from '../../types';
import { buildMultisigIsmConfig } from '../ism';

// the addresses here must line up with the e2e test's validator addresses
// Validators are anvil accounts 4-6
export const chainToValidator: Record<string, string> = {
  test1: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  test2: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  test3: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
};

export const chainToMultisig: ChainMap<MultisigConfig> = {
  test1: {
    validators: [chainToValidator['test1']],
    threshold: 1,
  },
  test2: {
    validators: [chainToValidator['test2']],
    threshold: 1,
  },
  test3: {
    validators: [chainToValidator['test3']],
    threshold: 1,
  },
};

// the addresses here must line up with the e2e test's validator addresses
export const multisigIsm: ChainMap<MultisigIsmConfig> = {
  // Validators are anvil accounts 4-6
  test1: buildMultisigIsmConfig(
    chainToMultisig['test1'],
    IsmType.MESSAGE_ID_MULTISIG,
  ),
  test2: buildMultisigIsmConfig(
    chainToMultisig['test2'],
    IsmType.MERKLE_ROOT_MULTISIG,
  ),
  test3: buildMultisigIsmConfig(
    chainToMultisig['test3'],
    IsmType.MESSAGE_ID_MULTISIG,
  ),
};
