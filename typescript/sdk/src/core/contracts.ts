import {
  Create2Factory__factory,
  InterchainAccountRouter__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  InterchainQueryRouter__factory,
  Mailbox,
  Mailbox__factory,
  MultisigIsm,
  MultisigIsm__factory,
  ProxyAdmin,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { ProxiedContract, TransparentProxyAddresses } from '../proxy';

type ConnectionClientContracts = {
  interchainGasPaymaster: ProxiedContract<
    InterchainGasPaymaster,
    TransparentProxyAddresses
  >;
};

export type CoreContracts = ConnectionClientContracts & {
  mailbox: ProxiedContract<Mailbox, TransparentProxyAddresses>;
  multisigIsm: MultisigIsm;
  proxyAdmin: ProxyAdmin;
};

export const coreFactories = {
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  create2Factory: new Create2Factory__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
  interchainGasPaymaster: new InterchainGasPaymaster__factory(),
  multisigIsm: new MultisigIsm__factory(),
  mailbox: new Mailbox__factory(),
};
