import {
  AgentConfig,
  ChainMap,
  ScraperConfig as ScraperAgentConfig,
} from '@hyperlane-xyz/sdk';

import { Role } from '../../roles.js';
import { HelmStatefulSetValues } from '../infrastructure.js';

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

    return {
      chainsToScrape: chainsToScrape.join(','),
    };
  }

  get role(): Role {
    return Role.Scraper;
  }
}
