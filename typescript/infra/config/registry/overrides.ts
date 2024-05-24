import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import { MergedRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import { ChainMap, ChainMetadata } from '@hyperlane-xyz/sdk';
import { objMerge } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';

import { getRegistry } from './registry.js';

let registryWithOverrides: MergedRegistry;

export async function getRegistryWithOverrides(
  deployEnv: DeployEnvironment,
  chains: string[],
  chainMetadataOverrides: ChainMap<Partial<ChainMetadata>>,
): Promise<MergedRegistry> {
  if (registryWithOverrides) {
    return registryWithOverrides;
  }

  const baseRegistry = getRegistry();

  const overrideRegistry = new PartialRegistry({
    chainMetadata: {
      ...objMerge(
        chainMetadataOverrides,
        await getSecretMetadataOverrides(deployEnv, chains),
      ),
    },
  });

  registryWithOverrides = new MergedRegistry({
    registries: [baseRegistry, overrideRegistry],
  });
  return registryWithOverrides;
}

async function getSecretMetadataOverrides(
  deployEnv: DeployEnvironment,
  chains: string[],
): Promise<ChainMap<Partial<ChainMetadata>>> {
  const projectId = 'abacus-labs-dev';

  const client = new SecretManagerServiceClient({
    projectId,
  });

  const metadataOverrides: ChainMap<Partial<ChainMetadata>> = {};

  for (const chain of chains) {
    const secretName = `${deployEnv}-rpc-endpoints-${chain}`;
    const [secretVersion] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    const secretData = secretVersion.payload?.data;
    if (!secretData) {
      console.warn('Secret missing payload', secretName);
      continue;
    }

    // Handle both string and Uint8Array
    let dataStr: string;
    if (typeof secretData === 'string') {
      dataStr = secretData;
    } else {
      dataStr = new TextDecoder().decode(secretData);
    }

    const rpcUrls = JSON.parse(dataStr);
    metadataOverrides[chain] = {
      rpcUrls: rpcUrls.map((rpcUrl: string) => ({
        http: rpcUrl,
      })),
    };
  }

  return metadataOverrides;
}
