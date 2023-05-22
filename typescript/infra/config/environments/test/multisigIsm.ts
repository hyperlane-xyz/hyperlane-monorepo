import { ChainMap, ModuleType, MultisigIsmConfig } from '@hyperlane-xyz/sdk';

// the addresses here must line up with the e2e test's validator addresses
export const multisigIsm: ChainMap<MultisigIsmConfig> = {
  // Validators are anvil accounts 4-6
  test1: {
    type: ModuleType.MULTISIG,
    validators: ['0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'],
    threshold: 1,
  },
  test2: {
    type: ModuleType.MULTISIG,
    validators: ['0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc'],
    threshold: 1,
  },
  test3: {
    type: ModuleType.MULTISIG,
    validators: ['0x976ea74026e726554db657fa54763abd0c3a0aa9'],
    threshold: 1,
  },
};
