import {
  LocalAccountViemSigner,
  type MultiProtocolProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  BaseMultiProtocolSigner,
  type IMultiProtocolSigner,
  type SignerConfig,
  type TypedSigner,
} from './BaseMultiProtocolSigner.js';

export class MultiProtocolSignerFactory {
  static getSignerStrategy(
    protocol: ProtocolType,
    multiProtocolProvider: MultiProtocolProvider,
  ): IMultiProtocolSigner {
    switch (protocol) {
      case ProtocolType.Ethereum:
        return new EvmSignerStrategy(multiProtocolProvider);
      default:
        throw new Error(`Unsupported protocol: ${protocol}`);
    }
  }
}

class EvmSignerStrategy extends BaseMultiProtocolSigner {
  async getSigner(config: SignerConfig): Promise<TypedSigner> {
    const { privateKey } = await this.getPrivateKey(config);
    return new LocalAccountViemSigner(privateKey as `0x${string}`);
  }
}
