import { InterchainAccountRouter__factory } from '@hyperlane-xyz/core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { EvmRouterReader } from '../router/EvmRouterReader.js';

import { DerivedIcaRouterConfig, IcaRouterType } from './types.js';

export class EvmIcaRouterReader extends EvmRouterReader {
  public async deriveConfig(address: Address): Promise<DerivedIcaRouterConfig> {
    const icaRouterInstance = InterchainAccountRouter__factory.connect(
      address,
      this.provider,
    );

    let commitmentIsmAddress: string | undefined;
    let routerType: IcaRouterType;
    try {
      commitmentIsmAddress = await icaRouterInstance.CCIP_READ_ISM();
      routerType = IcaRouterType.REGULAR;
    } catch {
      rootLogger.debug(
        `No CCIP_READ_ISM on ${address} — MinimalInterchainAccountRouter`,
      );
      routerType = IcaRouterType.MINIMAL;
    }

    const routerConfig = await this.readRouterConfig(address);
    const commitmentIsm = commitmentIsmAddress
      ? await this.evmIsmReader.deriveOffchainLookupConfig(commitmentIsmAddress)
      : undefined;

    return {
      address,
      ...routerConfig,
      routerType,
      ...(commitmentIsm ? { commitmentIsm } : {}),
    };
  }
}
