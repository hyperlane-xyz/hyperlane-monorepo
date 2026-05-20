import { ProtocolType } from '@hyperlane-xyz/utils';

export function normalizeKeyFunderProtocol(
  protocol: ProtocolType,
): ProtocolType {
  return protocol === ProtocolType.Cosmos
    ? ProtocolType.CosmosNative
    : protocol;
}
