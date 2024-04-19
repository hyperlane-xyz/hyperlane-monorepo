import { IsmType, RoutingIsmConfig } from '@hyperlane-xyz/sdk';

import { multisigIsm } from './multisigIsm.js';

export const routingIsm = (
  local_chain: string,
  owner: string,
): RoutingIsmConfig => {
  return {
    type: IsmType.ROUTING,
    owner,
    domains: Object.fromEntries(
      Object.entries(multisigIsm).filter(([chain]) => chain !== local_chain),
    ),
  };
};
