import {
  AgentConfig,
  ScraperConfig as ScraperAgentConfig,
} from '@hyperlane-xyz/sdk';

import { Role } from '../../roles.js';
import { HelmStatefulSetValues } from '../infrastructure.js';

import { AgentConfigHelper, RootAgentConfig } from './agent.js';

export interface BaseScraperConfig {
  // no configs at this time
  __placeholder?: undefined;
}

// Ignore db which is added by helm
export type ScraperConfig = Omit<ScraperAgentConfig, keyof AgentConfig | 'db'>;

export interface HelmScraperValues extends HelmStatefulSetValues {
  config?: ScraperConfig;
}

export class ScraperConfigHelper extends AgentConfigHelper<ScraperConfig> {
  constructor(agentConfig: RootAgentConfig) {
    if (!agentConfig.scraper)
      throw Error('Scraper is not defined for this context');
    super(agentConfig, agentConfig.scraper);
  }

  async buildConfig(): Promise<ScraperConfig> {
    return {
      chainsToScrape: this.contextChainNames[Role.Scraper].join(','),
    };
  }

  get role(): Role {
    return Role.Scraper;
  }
}
