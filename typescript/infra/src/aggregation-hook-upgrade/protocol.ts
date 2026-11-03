import { ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

// Standard EVM chains derive CREATE addresses from the creator's nonce, are
// covered by the SDK's explorer verifier, and can be forked locally. Tron does
// none of these: the TVM assigns contract addresses from the transaction id,
// the SDK skips Tron verification, and a local fork cannot run TVM contracts.
export function isStandardEvm(protocol: ProtocolType): boolean {
  return protocol === ProtocolType.Ethereum;
}

export function assertForkable(chain: ChainName, protocol: ProtocolType): void {
  assert(
    isStandardEvm(protocol),
    `--fork is not supported for ${chain}: a local fork cannot emulate protocol ${protocol}`,
  );
}
