import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { REGISTRY_PATH } from '../consts.js';

export async function deployToken(
  mailbox: string,
  privateKey: string,
  chain: string,
): Promise<Address> {
  const { multiProvider } = await getContext({
    registryUris: [REGISTRY_PATH],
    key: privateKey,
  });

  const metadata = multiProvider.getChainMetadata(chain);

  const wallet = await DirectSecp256k1Wallet.fromKey(
    Buffer.from(privateKey, 'hex'),
    metadata.bech32Prefix,
  );

  const signer = await SigningHyperlaneModuleClient.connectWithSigner(
    metadata.rpcUrls[0].http,
    wallet,
    {
      gasPrice: GasPrice.fromString(
        `${metadata.gasPrice?.amount}${metadata.gasPrice?.denom}`,
      ),
    },
  );

  const { response } = await signer.createSyntheticToken({
    origin_mailbox: mailbox,
  });

  return response.id;
}
