import { ProtocolType } from '@hyperlane-xyz/utils';

// Standard EVM chains derive CREATE addresses from the creator's nonce and are
// covered by the SDK's explorer verifier. Tron does neither: the TVM assigns
// contract addresses from the transaction id, and the SDK skips Tron
// verification.
export function isStandardEvm(protocol: ProtocolType): boolean {
  return protocol === ProtocolType.Ethereum;
}
