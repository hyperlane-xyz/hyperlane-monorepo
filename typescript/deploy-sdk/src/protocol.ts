import {
  ProtocolType,
  hasProtocol,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

export async function loadProtocolProviders(
  neededProtocols: Set<ProtocolType>,
) {
  for (const protocol of neededProtocols) {
    if (hasProtocol(protocol)) {
      rootLogger.debug(`${protocol} already loaded`);
      continue;
    }
    switch (protocol) {
      case ProtocolType.CosmosNative: {
        const { CosmosNativeProtocolProvider } =
          await import('@hyperlane-xyz/cosmos-sdk');
        registerProtocol(protocol, () => new CosmosNativeProtocolProvider());
        break;
      }
      case ProtocolType.Radix: {
        const { RadixProtocolProvider } =
          await import('@hyperlane-xyz/radix-sdk');
        registerProtocol(protocol, () => new RadixProtocolProvider());
        break;
      }
      case ProtocolType.Aleo: {
        const { AleoProtocolProvider } =
          await import('@hyperlane-xyz/aleo-sdk');
        registerProtocol(protocol, () => new AleoProtocolProvider());
        break;
      }
    }
  }
}
