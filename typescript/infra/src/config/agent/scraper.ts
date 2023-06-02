import { Role } from '../../roles';
import { HelmStatefulSetValues } from '../infrastructure';

import { AgentConfigHelper, RootAgentConfig } from './agent';

export interface BaseScraperConfig {
  // no configs at this time
  __placeholder?: undefined;
}

export type ScraperConfig = BaseScraperConfig;

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
    return {};
  }

  get role(): Role {
    return Role.Scraper;
  }
}
