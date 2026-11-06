import { ChainMap } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

export enum IcaRouterVersion {
  V2 = 'v2',
  V3 = 'v3',
}

// Selects the routers being checked, independently of the v2 routers used to
// control governance ICAs. A missing v3 deployment must never fall back to v2.
export function selectIcaRouterAddresses(
  addresses: ChainMap<Record<string, Address>>,
  version: IcaRouterVersion,
): ChainMap<Record<string, Address>> {
  return Object.fromEntries(
    Object.entries(addresses).flatMap(([chain, contracts]) => {
      const router =
        version === IcaRouterVersion.V3
          ? contracts.interchainAccountRouterV3
          : contracts.interchainAccountRouter;
      return router
        ? [[chain, { ...contracts, interchainAccountRouter: router }]]
        : [];
    }),
  );
}
