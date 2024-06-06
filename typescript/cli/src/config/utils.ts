import { HookConfig, HookType, IsmConfig, IsmType } from '@hyperlane-xyz/sdk';

import { logGray } from '../logger.js';

export function callWithConfigCreationLogsSync<
  T extends IsmType | HookType,
  C extends IsmConfig | HookConfig,
>(fn: (...args: any[]) => C, type: T) {
  return (...args: any[]): C => {
    logGray(`Creating ${type}...`);
    try {
      const result = fn(...args);
      return result;
    } finally {
      logGray(`Created ${type}`!);
    }
  };
}

export function callWithConfigCreationLogsAsync<
  T extends IsmType | HookType,
  C extends IsmConfig | HookConfig,
>(fn: (...args: any[]) => Promise<C>, type: T) {
  return async (...args: any[]): Promise<C> => {
    logGray(`Creating ${type}...`);
    try {
      const result = await fn(...args);
      return result;
    } finally {
      logGray(`Created ${type}`!);
    }
  };
}
