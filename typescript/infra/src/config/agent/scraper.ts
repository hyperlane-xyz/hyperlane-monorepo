import {
  AgentConfig,
  ChainMap,
  ScraperConfig as ScraperAgentConfig,
  TOKEN_CROSS_COLLATERAL_STANDARDS,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import { isAddress } from '@hyperlane-xyz/utils';

import { getDomainId, getRegistry } from '../../../config/registry.js';
import { Role } from '../../roles.js';
import type { HelmStatefulSetValues } from '../infrastructure.js';

import { AgentConfigHelper, RootAgentConfig } from './agent.js';

export interface BaseScraperConfig {
  scraperOnlyChains?: ChainMap<boolean>;
}

// Ignore db which is added by helm
export type ScraperConfig = Omit<ScraperAgentConfig, keyof AgentConfig | 'db'>;

export interface HelmScraperValues extends HelmStatefulSetValues {
  config?: ScraperConfig;
}

/**
 * Combines the context chain names with the scraper-only chains to create a complete list of chains to scrape.
 *
 * @param contextChainNames - The chains from the agent context configuration
 * @param scraperOnlyChains - Additional chains that should only be scraped
 * @returns An array of chain names to be scraped
 */
export function getCombinedChainsToScrape(
  contextChainNames: string[],
  scraperOnlyChains: ChainMap<boolean> = {},
  enabledOnly = false,
): string[] {
  const chainsToScrape = new Set(contextChainNames);

  // Add all scraper-only chains so we don't need to rebuild images to enable them
  for (const chain of Object.keys(scraperOnlyChains)) {
    if (enabledOnly && !scraperOnlyChains[chain]) {
      continue;
    }
    chainsToScrape.add(chain);
  }

  return Array.from(chainsToScrape).sort();
}

export function buildCcrRoutersConfig(
  chainsToScrape: string[],
): Record<string, Record<string, string>> {
  const chainsSet = new Set(chainsToScrape);
  const ccrRouters: Record<string, Record<string, string>> = {};

  const allWarpRoutes = getRegistry().getWarpRoutes();
  for (const warpCoreConfig of Object.values(allWarpRoutes)) {
    for (const token of warpCoreConfig.tokens) {
      if (
        !TOKEN_CROSS_COLLATERAL_STANDARDS.has(token.standard as TokenStandard)
      )
        continue;
      if (
        !token.addressOrDenom ||
        !token.collateralAddressOrDenom ||
        !token.chainName
      )
        continue;
      if (!chainsSet.has(token.chainName)) continue;
      if (
        !isAddress(token.addressOrDenom) ||
        !isAddress(token.collateralAddressOrDenom)
      )
        continue;

      let domainId: number;
      try {
        domainId = getDomainId(token.chainName);
      } catch {
        continue;
      }

      const domainKey = domainId.toString();
      if (!ccrRouters[domainKey]) ccrRouters[domainKey] = {};
      ccrRouters[domainKey][token.addressOrDenom] =
        token.collateralAddressOrDenom;
    }
  }

  return ccrRouters;
}

export class ScraperConfigHelper extends AgentConfigHelper<ScraperConfig> {
  constructor(agentConfig: RootAgentConfig) {
    if (!agentConfig.scraper)
      throw Error('Scraper is not defined for this context');
    super(agentConfig, agentConfig.scraper);
  }

  async buildConfig(): Promise<ScraperConfig> {
    // Combine the context chain names with the ENABLED scraper only chains
    const chainsToScrape = getCombinedChainsToScrape(
      this.contextChainNames[Role.Scraper],
      this.rawConfig.scraper?.scraperOnlyChains,
      true,
    );

    const ccrRouters = buildCcrRoutersConfig(chainsToScrape);

    return {
      chainsToScrape: chainsToScrape.join(','),
      ...(Object.keys(ccrRouters).length > 0 && { ccrRouters }),
    };
  }

  get role(): Role {
    return Role.Scraper;
  }
}
