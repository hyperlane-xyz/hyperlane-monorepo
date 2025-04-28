import { ethers } from 'ethers';

import {
  defaultMultisigConfigs,
  getValidatorFromStorageLocation,
} from '@hyperlane-xyz/sdk';

import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import { getArgs, withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

enum CheckResult {
  OK = '✅',
  WARNING = '🚨',
}

async function main() {
  const { environment, chains } = await withChains(getArgs()).argv;
  const config = getEnvironmentConfig(environment);
  const { core } = await getHyperlaneCore(environment);

  // Ensure we skip lumia, as we don't have the addresses in registry.
  const targetNetworks = (
    chains && chains.length > 0 ? chains : config.supportedChainNames
  ).filter((chain) => isEthereumProtocolChain(chain) && chain !== 'lumia');

  // set useSecrets to `false` to compare with public RPCs instead of private ones
  const registry = await config.getRegistry(false);
  const metadata = await registry.getMetadata();

  const publicRpcs: string[] = [];

  for (const chain of targetNetworks) {
    const chainMetadata = metadata[chain];
    if (!chainMetadata) {
      throw new Error(`No metadata for ${chain}`);
    }
    publicRpcs.push(
      ...chainMetadata.rpcUrls.map((rpc) =>
        ethers.utils.solidityKeccak256(['string'], [rpc.http]),
      ),
    );
    if (chainMetadata.grpcUrls)
      publicRpcs.push(
        ...chainMetadata.grpcUrls.map((rpc) =>
          ethers.utils.solidityKeccak256(['string'], [rpc.http]),
        ),
      );
  }
  const output: {
    chain: string;
    validator: string;
    status: CheckResult;
    rpcs: string;
    private: string;
  }[] = [];

  await Promise.all(
    targetNetworks.map(async (chain) => {
      const validatorAnnounce = core.getContracts(chain).validatorAnnounce;
      const defaultValidatorConfigs =
        defaultMultisigConfigs[chain].validators || [];
      const validators = defaultValidatorConfigs.map((v) => v.address);

      const storageLocations =
        await validatorAnnounce.getAnnouncedStorageLocations(validators);

      for (let i = 0; i < defaultValidatorConfigs.length; i++) {
        const { address: validator, alias } = defaultValidatorConfigs[i];
        const location = storageLocations[i][storageLocations[i].length - 1];

        try {
          const validatorInstance = await getValidatorFromStorageLocation(
            location,
          );
          const metadata = await validatorInstance.getMetadata();

          const matchCount = publicRpcs.filter((rpc) =>
            metadata.rpcs?.some((x) => x == rpc),
          ).length;
          const rpcCount = metadata.rpcs?.length;

          output.push({
            chain,
            validator: alias ?? validator,
            status: CheckResult.OK,
            rpcs: `${rpcCount ?? '?'}`,
            private: !rpcCount ? '?/?' : `${rpcCount - matchCount}/${rpcCount}`,
          });
        } catch {
          output.push({
            chain,
            validator: alias ?? validator,
            status: CheckResult.WARNING,
            rpcs: '?',
            private: '?/?',
          });
        }
      }

      return {
        chain,
      };
    }),
  );

  console.table(output);
}

main().catch(console.error);
