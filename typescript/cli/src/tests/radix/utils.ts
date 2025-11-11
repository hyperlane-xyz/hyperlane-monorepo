import { RadixSigner } from '@hyperlane-xyz/radix-sdk';
import { retryAsync } from '@hyperlane-xyz/utils';

import { HYP_KEY_BY_PROTOCOL, TestChainMetadata } from '../constants.js';

export async function deployHyperlaneRadixPackageDefinition(
  chainMetadata: TestChainMetadata,
  hyperlanePackageArtifacts: {
    code: Uint8Array;
    packageDefinition: Uint8Array;
  },
) {
  // Adding dummy package address to avoid the signer crashing because
  // no Hyperlane package is deployed on the new node
  chainMetadata.packageAddress = 'not-yet-deployed';
  const signer = (await RadixSigner.connectWithSigner(
    chainMetadata.rpcUrls.map((rpc) => rpc.http),
    HYP_KEY_BY_PROTOCOL.radix,
    {
      metadata: chainMetadata,
    },
  )) as RadixSigner;

  // Fund the account with the internal signer
  // Use retryAsync to handle transient errors (e.g., epoch expiry)
  await retryAsync(
    () => signer['signer'].getTestnetXrd(),
    3, // attempts
    1000, // base retry delay (1 second)
  );
  console.log(
    `Funded test account on ${chainMetadata.name} before publishing the hyperlane package`,
  );
  const packageAddress = await signer.publishPackage({
    code: hyperlanePackageArtifacts.code,
    packageDefinition: hyperlanePackageArtifacts.packageDefinition,
  });
  chainMetadata.packageAddress = packageAddress;
}
