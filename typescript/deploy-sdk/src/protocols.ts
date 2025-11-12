import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ProtocolRegistrar,
  registerProtocol,
} from '@hyperlane-xyz/provider-sdk/registry';

// Loads a set of Providers, given a chain
export async function loadProviders(neededProtocols: ProtocolType[]) {
  await Promise.all(
    neededProtocols.map(async (protocol) => {
      switch (protocol) {
        case ProtocolType.CosmosNative: {
          const { CosmosNativeProviderFactory } = await import(
            '@hyperlane-xyz/cosmos-sdk'
          );
          registerProtocol((registrar: ProtocolRegistrar) => {
            registrar.registerProtocol(
              protocol,
              () => new CosmosNativeProviderFactory(),
            );
          });
          break;
        }
      }
    }),
  );
}
