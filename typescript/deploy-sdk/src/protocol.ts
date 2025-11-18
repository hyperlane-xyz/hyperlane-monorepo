import { ProtocolType, registerProtocol } from '@hyperlane-xyz/provider-sdk';

export async function loadProviders(neededProtocols: Set<ProtocolType>) {
  for (const protocol of neededProtocols) {
    switch (protocol) {
      case ProtocolType.CosmosNative: {
        const { CosmosNativeProtocolProvider } = await import(
          '@hyperlane-xyz/cosmos-sdk'
        );
        registerProtocol(protocol, () => new CosmosNativeProtocolProvider());
        break;
      }
    }
  }
}
