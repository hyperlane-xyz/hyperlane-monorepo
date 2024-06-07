import { HookConfig, HookType, IsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import { logGray } from '../logger.js';

export function callWithConfigCreationLogs<T extends IsmConfig | HookConfig>(
  fn: (...args: any[]) => Promise<T>,
  type: IsmType | HookType,
) {
  return async (...args: any[]): Promise<T> => {
    logGray(`Creating ${type}...`);
    try {
      const result = await fn(...args);
      return result;
    } finally {
      logGray(`Created ${type}!`);
    }
  };
}
