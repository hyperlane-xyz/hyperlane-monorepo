import {
  LegacyMultisigIsm__factory,
  Mailbox__factory,
  ProxyAdmin__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';

/*
export type CoreAddresses = HyperlaneAddresses<
  mailbox: types.Address;
  multisigIsm: types.Address;
  proxyAdmin: types.Address;
  validatorAnnounce: types.Address;
};

export type CoreContracts = {
  mailbox: ProxiedContract<Mailbox, TransparentProxyAddresses>;
  multisigIsm: LegacyMultisigIsm;
  proxyAdmin: ProxyAdmin;
  validatorAnnounce: ValidatorAnnounce;
};
*/

export const coreFactories = {
  validatorAnnounce: new ValidatorAnnounce__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  multisigIsm: new LegacyMultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
};
