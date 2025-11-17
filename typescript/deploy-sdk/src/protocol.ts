import { ProtocolType, registerProtocol } from '@hyperlane-xyz/provider-sdk';

export async function loadProviders(neededProtocols: ProtocolType[]) {
  await Promise.all(
    neededProtocols.map(async (protocol) => {
      switch (protocol) {
        case ProtocolType.CosmosNative: {
          const { CosmosNativeProviderFactory } = await import(
            '@hyperlane-xyz/cosmos-sdk'
          );
          registerProtocol(protocol, () => new CosmosNativeProviderFactory());
          break;
        }
      }
    }),
  );
}
