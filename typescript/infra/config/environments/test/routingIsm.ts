import { ModuleType, RoutingIsmConfig } from '@hyperlane-xyz/sdk';

import { multisigIsm } from './multisigIsm';

export const routingIsm = (
  local_chain: string,
  owner: string,
): RoutingIsmConfig => {
  return {
    type: ModuleType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(multisigIsm).filter(([chain]) => chain !== local_chain),
    ),
  };
};
