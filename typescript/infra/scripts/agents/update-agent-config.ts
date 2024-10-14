import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainTechnicalStack,
  CoreFactories,
  HyperlaneContracts,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  MultiProvider,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  objFilter,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import {
  DeployEnvironment,
  envNameToAgentEnv,
} from '../../src/config/environment.js';
import { getCosmosChainGasPrice } from '../../src/config/gas-oracle.js';
import {
  chainIsProtocol,
  filterRemoteDomainMetadata,
  isEthereumProtocolChain,
  writeMergedJSONAtPath,
} from '../../src/utils/utils.js';
import {
  Modules,
  getAddresses,
  getAgentConfig,
  getAgentConfigJsonPath,
  getArgs,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const { environment } = await getArgs().argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();
  await writeAgentConfig(multiProvider, environment);
}

// Keep as a function in case we want to use it in the future
export async function writeAgentConfig(
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  // Get the addresses for the environment
  const addressesMap = getAddresses(
    environment,
    Modules.CORE,
  ) as ChainMap<ChainAddresses>;

  const addressesForEnv = filterRemoteDomainMetadata(addressesMap);
  const core = HyperlaneCore.fromAddressesMap(addressesForEnv, multiProvider);

  const evmContractsMap = objFilter(
    core.contractsMap,
    (chain, _): _ is HyperlaneContracts<CoreFactories> =>
      isEthereumProtocolChain(chain),
  );

  // Write agent config indexing from the deployed Mailbox which stores the block number at deployment
  const startBlocks = await promiseObjAll(
    objMap(
      evmContractsMap,
      async (chain: string, contracts: HyperlaneContracts<CoreFactories>) => {
        const { index, technicalStack } = multiProvider.getChainMetadata(chain);
        const indexFrom = index?.from;

        // Arbitrum Nitro chains record the L1 block number they were deployed at,
        // not the L2 block number.
        // See: https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time#ethereum-block-numbers-within-arbitrum
        if (
          technicalStack === ChainTechnicalStack.ArbitrumNitro &&
          !indexFrom
        ) {
          // Should never get here because registry should enforce this, but we're being defensive.
          throw new Error(
            `index.from is not set for Arbitrum Nitro chain ${chain}`,
          );
        }

        // If the index.from is specified in the chain metadata, use that.
        if (indexFrom) {
          return indexFrom;
        }

        const mailbox = contracts.mailbox;
        try {
          const deployedBlock = await mailbox.deployedBlock();
          return deployedBlock.toNumber();
        } catch (err) {
          console.error(
            'Failed to get deployed block, defaulting to 0. Chain:',
            chain,
            'Error:',
            err,
          );
          return undefined;
        }
      },
    ),
  );

  // Get gas prices for Cosmos chains.
  // Instead of iterating through `addresses`, which only includes EVM chains,
  // iterate through the environment chain names.
  const envAgentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const environmentChains = envAgentConfig.environmentChainNames;
  const additionalConfig = Object.fromEntries(
    await Promise.all(
      environmentChains
        .filter((chain) => chainIsProtocol(chain, ProtocolType.Cosmos))
        .map(async (chain) => [
          chain,
          {
            gasPrice: await getCosmosChainGasPrice(chain),
          },
        ]),
    ),
  );

  const agentConfig = buildAgentConfig(
    environmentChains,
    await getEnvironmentConfig(environment).getMultiProvider(
      undefined,
      undefined,
      // Don't use secrets
      false,
    ),
    addressesForEnv as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
    additionalConfig,
  );

  writeMergedJSONAtPath(
    getAgentConfigJsonPath(envNameToAgentEnv[environment]),
    agentConfig,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Failed to update agent config', e);
    process.exit(1);
  });
