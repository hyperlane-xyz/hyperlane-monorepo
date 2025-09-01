import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import path from 'path';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import { Address } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { REGISTRY_PATH, getCombinedWarpRoutePath } from '../consts.js';

export const GET_WARP_DEPLOY_CORE_CONFIG_OUTPUT_PATH = (
  originalDeployConfigPath: string,
  symbol: string,
): string => {
  const fileName = path.parse(originalDeployConfigPath).name;

  return getCombinedWarpRoutePath(symbol, [fileName]);
};

export async function deployCollateralToken(
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

  const { response } = await signer.createCollateralToken({
    origin_mailbox: mailbox,
    origin_denom: metadata.nativeToken?.denom ?? '',
  });

  return response.id;
}

export async function deploySyntheticToken(
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
