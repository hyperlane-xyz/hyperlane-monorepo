import { Contexts } from '../../../config/contexts';
import { HelmStatefulSetValues } from '../infrastructure';

import { AgentConfig, AgentConfigHelper, ConfigHelper } from './agent';

export interface BaseScraperConfig {
  // no configs at this time
  __placeholder?: undefined;
}

export type ScraperConfig = BaseScraperConfig;

export interface HelmScraperValues extends HelmStatefulSetValues {
  config?: ScraperConfig;
}

export class ScraperConfigHelper
  extends AgentConfigHelper
  implements ConfigHelper<ScraperConfig>
{
  readonly #scraperConfig?: BaseScraperConfig;

  constructor(agentConfig: AgentConfig) {
    super(agentConfig, agentConfig.scraper);
    this.#scraperConfig = agentConfig.scraper;
  }

  get isDefined(): boolean {
    return !!this.#scraperConfig && this.context == Contexts.Hyperlane;
  }

  async buildConfig(): Promise<ScraperConfig | undefined> {
    return this.isDefined ? undefined : {};
  }
}
