import { type ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getSigner } from '../../../utils/keys.js';
import { type CommandContext } from '../../types.js';

import { HttpRemoteEvmSigner } from './HttpRemoteEvmSigner.js';
import { HttpSignerClient } from './HttpSignerClient.js';
import { parseSignerSource, SignerSourceType } from './signerSource.js';

type SignerAddressContext = Pick<
  CommandContext,
  'altVmSigners' | 'key' | 'multiProvider' | 'skipConfirmation'
>;

export async function tryResolveSignerAddress(
  context: SignerAddressContext,
  chain?: ChainName,
): Promise<string | undefined> {
  if (chain) {
    const evmSigner = context.multiProvider.tryGetSigner(chain);
    if (evmSigner) return evmSigner.getAddress();

    const altVmSigner = context.altVmSigners[chain];
    if (altVmSigner) return altVmSigner.getSignerAddress();

    if (context.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
      return undefined;
    }
  }

  const key = context.key?.[ProtocolType.Ethereum];
  if (!key) return undefined;

  const source = parseSignerSource(key);
  switch (source.type) {
    case SignerSourceType.PRIVATE_KEY: {
      const { signer } = await getSigner({
        key: source.privateKey,
        skipConfirmation: context.skipConfirmation,
      });
      return signer.getAddress();
    }
    case SignerSourceType.HTTP:
      if (!chain) return undefined;
      return (
        await HttpRemoteEvmSigner.create(
          new HttpSignerClient(source.url),
          chain,
          source.expectedAddress,
        )
      ).getAddress();
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unhandled signer source: ${String(_exhaustive)}`);
    }
  }
}
