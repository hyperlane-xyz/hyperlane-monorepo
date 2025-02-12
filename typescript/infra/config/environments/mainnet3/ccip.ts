import { ChainMap, ChainName, getCCIPChains } from '@hyperlane-xyz/sdk';

export function getCCIPDeployConfig(
  targetNetworks: ChainName[],
): ChainMap<Set<ChainName>> {
  const chains = getCCIPChains().filter((chain) =>
    targetNetworks.includes(chain),
  );
  return Object.fromEntries(
    chains.map((origin) => [
      origin,
      new Set(chains.filter((chain) => chain !== origin)),
    ]),
  );
}
