import { Address } from '@hyperlane-xyz/utils';

import { ChainMap, ChainName } from '../../types';

export type GovernanceConfig = {
  owner: Address;
  hub: ChainName;
  spokes: Array<ChainName>;
};

export type AccountConfig = {
  origin: ChainName;
  owner: Address;
  localRouter?: Address;
};

export function governanceToAccountConfig(
  gov: GovernanceConfig,
): ChainMap<AccountConfig> {
  // TODO
  // govConfig = { owner: alice, hub: A, spokes: [B, C] }
  // accountConfig = {  B: { origin: A, owner: alice }, C: { origin: A, owner: alice } }
  const acc = gov.spokes.reduce(
    (acc, spoke) => ({
      ...acc,
      [spoke]: { origin: gov.hub, owner: gov.owner },
    }),
    {} as ChainMap<AccountConfig>,
  );
  return acc;
}
