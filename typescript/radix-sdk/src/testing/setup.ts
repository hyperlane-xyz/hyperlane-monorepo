import { TestChainMetadata } from '@hyperlane-xyz/provider-sdk/chain';
import { assert, retryAsync, rootLogger } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';

import {
  HYPERLANE_RADIX_GIT,
  HYPERLANE_RADIX_VERSION,
  TEST_RADIX_CHAIN_METADATA,
  TEST_RADIX_PRIVATE_KEY,
} from './constants.js';

export interface RadixContractArtifacts {
  code: Uint8Array;
  packageDefinition: Uint8Array;
}

/**
 * Downloads a file from a URL and returns it as a Uint8Array
 */
async function downloadFile(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Downloads Radix contract artifacts (WASM and RPD files) from GitHub releases
 */
export async function downloadRadixContracts(): Promise<RadixContractArtifacts> {
  rootLogger.info(`Downloading hyperlane-radix v${HYPERLANE_RADIX_VERSION}...`);

  const wasmUrl = `${HYPERLANE_RADIX_GIT}/releases/download/v${HYPERLANE_RADIX_VERSION}/hyperlane_radix.wasm`;
  const rpdUrl = `${HYPERLANE_RADIX_GIT}/releases/download/v${HYPERLANE_RADIX_VERSION}/hyperlane_radix.rpd`;

  const [code, packageDefinition] = await Promise.all([
    downloadFile(wasmUrl),
    downloadFile(rpdUrl),
  ]);

  rootLogger.info('Downloaded Radix contracts successfully');
  return { code, packageDefinition };
}

/**
 * Deploys the Hyperlane Radix package to a test chain and adds it to the provided metadata
 */
export async function deployHyperlaneRadixPackage(
  chainMetadata: TestChainMetadata = TEST_RADIX_CHAIN_METADATA,
  hyperlanePackageArtifacts: RadixContractArtifacts,
  privateKey: string = TEST_RADIX_PRIVATE_KEY,
): Promise<string> {
  // Adding dummy package address to avoid the signer crashing because
  // no Hyperlane package is deployed on the new node
  const metadata: TestChainMetadata = {
    ...chainMetadata,
    packageAddress: 'not-yet-deployed',
  };

  const rpcUrls = metadata.rpcUrls?.map((rpc) => rpc.http) ?? [];
  assert(rpcUrls.length > 0, `Expected radix rpc urls not to be empty`);

  const signer = (await RadixSigner.connectWithSigner(rpcUrls, privateKey, {
    metadata,
  })) as RadixSigner;

  // Fund the account with the internal signer
  // Use retryAsync to handle transient errors (e.g., epoch expiry)
  await retryAsync(
    () => signer['signer'].getTestnetXrd(),
    3, // attempts
    3000, // base retry delay (3 seconds)
  );

  rootLogger.info(
    `Funded test account on ${metadata.name} before publishing the hyperlane package`,
  );

  const packageAddress = await signer.publishPackage({
    code: hyperlanePackageArtifacts.code,
    packageDefinition: hyperlanePackageArtifacts.packageDefinition,
  });

  rootLogger.info(`Deployed Hyperlane package to: ${packageAddress}`);

  return packageAddress;
}
