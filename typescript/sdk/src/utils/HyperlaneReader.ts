import { type providers } from 'ethers';
import { type LevelWithSilentOrString } from 'pino';

import { type MultiProvider } from '../providers/MultiProvider.js';
import { type HyperlaneSmartProvider } from '../providers/SmartProvider/SmartProvider.js';
import { type ChainNameOrId } from '../types.js';

export class HyperlaneReader {
  provider: providers.Provider;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
  }

  /**
   * Conditionally sets the log level for a smart provider.
   *
   * @param level - The log level to set, e.g. 'debug', 'info', 'warn', 'error'.
   */
  protected setSmartProviderLogLevel(level: LevelWithSilentOrString): void {
    if ('setLogLevel' in this.provider) {
      (this.provider as HyperlaneSmartProvider).setLogLevel(level);
    }
  }
}
