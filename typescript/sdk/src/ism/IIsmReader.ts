import { ProtocolType } from '@hyperlane-xyz/utils';

import { DerivedIsmConfig, IsmConfig } from './types.js';

/**
 * Reads the provided ism configuration from chain for the underlying {@link ProtocolType}
 */
export interface IIsmReader<TProtocol extends ProtocolType> {
  protocol: TProtocol;

  /**
   * Derives the provided ism configuration by reading the on chain contracts
   *
   * @throws if the configuration cannot be derived
   */
  deriveIsmConfig(config: IsmConfig): Promise<DerivedIsmConfig>;
}
