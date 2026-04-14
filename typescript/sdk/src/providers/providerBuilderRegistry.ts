import { ProtocolType } from '@hyperlane-xyz/utils';
import type { KnownProtocolType } from '@hyperlane-xyz/utils';

import type {
  ProviderBuilderFn,
  ProviderBuilderMap,
} from './providerBuilders.js';
import type { ProviderType, TypedProvider } from './ProviderType.js';

type ProtocolProviderBuilderMap = Partial<
  Record<KnownProtocolType, Partial<ProviderBuilderMap>>
>;

const registeredProviderBuilders: Partial<ProviderBuilderMap> = {};
const registeredProtocolProviderBuilders: ProtocolProviderBuilderMap = {};

export function registerProviderBuilders(
  providerBuilders: Partial<ProviderBuilderMap>,
): void {
  Object.assign(registeredProviderBuilders, providerBuilders);
}

export function registerProtocolProviderBuilders(
  protocol: KnownProtocolType,
  providerBuilders: Partial<ProviderBuilderMap>,
): void {
  registeredProtocolProviderBuilders[protocol] = {
    ...registeredProtocolProviderBuilders[protocol],
    ...providerBuilders,
  };
}

export function getRegisteredProviderBuilder(
  protocol: ProtocolType,
  type: ProviderType,
): ProviderBuilderFn<TypedProvider> | undefined {
  if (protocol !== ProtocolType.Unknown) {
    const protocolBuilder =
      registeredProtocolProviderBuilders[protocol]?.[type];
    if (protocolBuilder) return protocolBuilder;
  }

  return registeredProviderBuilders[type];
}

export function clearRegisteredProviderBuilders(): void {
  for (const providerType of Object.keys(registeredProviderBuilders)) {
    delete registeredProviderBuilders[providerType as ProviderType];
  }

  for (const protocol of Object.keys(registeredProtocolProviderBuilders)) {
    delete registeredProtocolProviderBuilders[protocol as KnownProtocolType];
  }
}
