import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import { EvmRouterReader } from '../router/EvmRouterReader.js';

import { DerivedIcaRouterConfig } from './types.js';

export class EvmIcaRouterReader extends EvmRouterReader {
  public async deriveConfig(address: Address): Promise<DerivedIcaRouterConfig> {
    const icaRouterInstance = InterchainAccountRouter__factory.connect(
      address,
      this.provider,
    );

    const commitmentIsmAddress = await icaRouterInstance.CCIP_READ_ISM();

    const [routerConfig, commitmentIsm] = await Promise.all([
      this.readRouterConfig(address),
      this.evmIsmReader.deriveOffchainLookupConfig(commitmentIsmAddress),
    ]);

    return {
      address,
      ...routerConfig,
      commitmentIsm,
    };
  }
}
