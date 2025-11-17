import { ProtocolType, registerProtocol } from '@hyperlane-xyz/provider-sdk';

export async function loadProviders(neededProtocols: ProtocolType[]) {
  await Promise.all(
    neededProtocols.map(async (protocol) => {
      switch (protocol) {
        case ProtocolType.CosmosNative: {
          const { CosmosNativeProviderV2 } = await import(
            '@hyperlane-xyz/cosmos-sdk'
          );
          registerProtocol(protocol, () => new CosmosNativeProviderV2());
          break;
        }
      }
    }),
  );
}
