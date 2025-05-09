import { ProtocolType } from '@hyperlane-xyz/utils';

import { DerivedHookConfig, HookConfig } from './types.js';

/**
 * Reads the provided hook configuration from chain for the underlying {@link ProtocolType}
 */
export interface IHookReader<TProtocol extends ProtocolType> {
  protocol: TProtocol;

  /**
   * Derives the provided hook configuration by reading the on chain contracts
   *
   * @throws if the configuration cannot be derived
   */
  deriveHookConfig(config: HookConfig): Promise<DerivedHookConfig>;
}
