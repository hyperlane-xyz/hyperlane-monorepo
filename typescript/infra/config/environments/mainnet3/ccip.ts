import { ChainMap, ChainName, getCCIPChains } from '@hyperlane-xyz/sdk';

export function getCCIPDeployConfig(
  targetNetworks: ChainName[],
): ChainMap<Set<ChainName>> {
  const ccipConfig: ChainMap<Set<ChainName>> = {};
  const chains = getCCIPChains().filter((chain) =>
    targetNetworks.includes(chain),
  );
  for (const origin of chains) {
    ccipConfig[origin] = new Set(chains.filter((chain) => chain !== origin));
  }
  return ccipConfig;
}
