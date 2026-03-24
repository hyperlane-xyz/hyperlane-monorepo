import { type CommandContext } from '../context/types.js';

import { getLogLevel } from '@hyperlane-xyz/utils';

/**
 * Temporarily overrides SmartProvider log level for selected chains while executing `fn`.
 * Intended for noisy probe-heavy flows like warp read/check.
 */
export async function withSmartProviderLogLevel<T>({
  context,
  chains,
  level,
  suppressCombinedProviderWarnLogs = false,
  fn,
}: {
  context: CommandContext;
  chains: string[];
  level: 'silent' | 'trace' | 'debug' | 'info' | 'warn' | 'error';
  suppressCombinedProviderWarnLogs?: boolean;
  fn: () => Promise<T>;
}): Promise<T> {
  const uniqueChains = [...new Set(chains)];
  const providers: Array<{
    setLogLevel: (l: string) => void;
    setSuppressCombinedProviderWarnLogs?: (s: boolean) => void;
  }> = [];

  for (const chain of uniqueChains) {
    try {
      const provider = context.multiProvider.getProvider(chain);
      if (provider && typeof (provider as any).setLogLevel === 'function') {
        (provider as any).setLogLevel(level);
        if (
          typeof (provider as any).setSuppressCombinedProviderWarnLogs ===
          'function'
        ) {
          (provider as any).setSuppressCombinedProviderWarnLogs(
            suppressCombinedProviderWarnLogs,
          );
        }
        providers.push(provider as any);
      }
    } catch {
      // Ignore chains without configured providers in this process.
    }
  }

  try {
    return await fn();
  } finally {
    const restoreLevel = getLogLevel();
    for (const provider of providers) {
      provider.setLogLevel(restoreLevel);
      provider.setSuppressCombinedProviderWarnLogs?.(false);
    }
  }
}
