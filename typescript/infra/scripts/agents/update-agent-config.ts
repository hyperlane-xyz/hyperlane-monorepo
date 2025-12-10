// eslint-disable-next-line
import fs from 'fs';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AgentConfig,
  ChainMap,
  ChainMetadata,
  ChainTechnicalStack,
  CoreFactories,
  HyperlaneContracts,
  HyperlaneCore,
  HyperlaneDeploymentArtifacts,
  MultiProvider,
  buildAgentConfig,
  getCosmosChainGasPrice,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  objFilter,
  objMap,
  objMerge,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import { agentSpecificChainMetadataOverrides } from '../../config/environments/mainnet3/chains.js';
import mainnet3GasPrices from '../../config/environments/mainnet3/gasPrices.json' with { type: 'json' };
import testnet4GasPrices from '../../config/environments/testnet4/gasPrices.json' with { type: 'json' };
import {
  RelayerAppContextConfig,
  RelayerConfigHelper,
} from '../../src/config/agent/relayer.js';
import { getCombinedChainsToScrape } from '../../src/config/agent/scraper.js';
import {
  DeployEnvironment,
  envNameToAgentEnv,
} from '../../src/config/environment.js';
import {
  chainIsProtocol,
  filterRemoteDomainMetadata,
  isEthereumProtocolChain,
  writeAndFormatJsonAtPath,
} from '../../src/utils/utils.js';
import {
  Modules,
  getAddresses,
  getAgentAppContextConfigJsonPath,
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
  await writeAgentAppContexts(multiProvider, environment);
}

// Keep as a function in case we want to use it in the future
export async function writeAgentConfig(
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  // Get gas prices for Cosmos chains.
  // Instead of iterating through `addresses`, which only includes EVM chains,
  // iterate through the environment chain names.

  const envConfig = getEnvironmentConfig(environment);
  const envAgentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const environmentChains = envAgentConfig.environmentChainNames;
  const registry =
    environment !== 'test' ? await envConfig.getRegistry() : undefined;

  // Build additional config for:
  // - cosmos/cosmos native chains that require special gas price handling
  // - any chains that have agent-specific overrides
  const additionalConfig = Object.fromEntries(
    await Promise.all(
      environmentChains.map(async (chain) => {
        let config: Partial<ChainMetadata> = {};

        // Get Cosmos gas price if applicable
        if (
          chainIsProtocol(chain, ProtocolType.Cosmos) ||
          chainIsProtocol(chain, ProtocolType.CosmosNative)
        ) {
          try {
            const gasPrice = await getCosmosChainGasPrice(chain, multiProvider);
            config.gasPrice = gasPrice;
          } catch (error) {
            rootLogger.error(`Error getting gas price for ${chain}:`, error);
            const { denom } = await multiProvider.getNativeToken(chain);
            assert(denom, `No nativeToken.denom found for chain ${chain}`);
            const amount =
              environment === 'mainnet3'
                ? mainnet3GasPrices[chain as keyof typeof mainnet3GasPrices]
                    .amount
                : testnet4GasPrices[chain as keyof typeof testnet4GasPrices]
                    .amount;
            config.gasPrice = { denom, amount };
          }
        }

        // Merge agent-specific overrides with general overrides
        // TODO: support testnet4 overrides (if we ever need to)
        const agentSpecificOverrides =
          agentSpecificChainMetadataOverrides[chain];
        if (agentSpecificOverrides && registry) {
          const chainMetadata = await registry.getChainMetadata(chain);
          assert(chainMetadata, `Chain metadata not found for chain ${chain}`);
          // Only care about blocks and transactionOverrides from the agent-specific overrides
          const { blocks, transactionOverrides } = objMerge(
            chainMetadata,
            agentSpecificOverrides,
          );
          config = objMerge(config, { blocks, transactionOverrides });
        }

        return [chain, config];
      }),
    ),
  );

  // Include scraper-only chains in the generatedagent config
  const agentConfigChains = getCombinedChainsToScrape(
    envAgentConfig.environmentChainNames,
    envAgentConfig.scraper?.scraperOnlyChains || {},
  );

  // Get the addresses for the environment
  const addressesMap = getAddresses(
    environment,
    Modules.CORE,
    agentConfigChains,
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
          rootLogger.error(
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

  // For each chain, ensure the required contract addresses are set
  let missingArtifactsCount = 0;
  for (const [chain, artifacts] of Object.entries(addressesForEnv)) {
    // required fields in HyperlaneDeploymentArtifacts
    const requiredArtifacts = [
      'merkleTreeHook',
      'interchainGasPaymaster',
      'mailbox',
      'validatorAnnounce',
    ];

    for (const artifact of requiredArtifacts) {
      if (!artifacts[artifact]) {
        rootLogger.warn(`${artifact} address not found for chain ${chain}`);
        missingArtifactsCount++;
      }
    }
  }

  // If there are missing addresses, fail the script
  assert(
    missingArtifactsCount === 0,
    `Missing ${missingArtifactsCount} addresses in configuration`,
  );

  const agentConfig = buildAgentConfig(
    agentConfigChains,
    await getEnvironmentConfig(environment).getMultiProvider(
      undefined,
      undefined,
      // Don't use secrets
      false,
      agentConfigChains,
    ),
    addressesForEnv as ChainMap<HyperlaneDeploymentArtifacts>,
    startBlocks,
    additionalConfig,
  );

  const filepath = getAgentConfigJsonPath(envNameToAgentEnv[environment]);
  console.log(`Writing config to ${filepath}`);
  if (fs.existsSync(filepath)) {
    const currentAgentConfig: AgentConfig = readJson<AgentConfig>(filepath);
    // Remove transactionOverrides from each chain in the agent config
    // To ensure all overrides are configured in infra code or the registry, and not in JSON
    for (const chainConfig of Object.values(currentAgentConfig.chains)) {
      // special case for 0g as we want some agent specific overrides
      if (chainConfig.name === 'zerogravity') {
        continue;
      }
      delete chainConfig.transactionOverrides;
    }
    writeAndFormatJsonAtPath(
      filepath,
      objMerge(currentAgentConfig, agentConfig),
    );
  } else {
    writeAndFormatJsonAtPath(filepath, agentConfig);
  }
}

export async function writeAgentAppContexts(
  multiProvider: MultiProvider,
  environment: DeployEnvironment,
) {
  const envAgentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const relayerConfig = await new RelayerConfigHelper(
    envAgentConfig,
  ).buildConfig();

  const agentConfigMap: RelayerAppContextConfig = {
    metricAppContexts: relayerConfig.metricAppContexts,
  };

  const filepath = getAgentAppContextConfigJsonPath(
    envNameToAgentEnv[environment],
  );
  console.log(`Writing config to ${filepath}`);
  if (fs.existsSync(filepath)) {
    const currentAgentConfigMap = readJson<RelayerAppContextConfig>(filepath);
    writeAndFormatJsonAtPath(
      filepath,
      objMerge(currentAgentConfigMap, agentConfigMap),
    );
  } else {
    writeAndFormatJsonAtPath(filepath, agentConfigMap);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    rootLogger.error('Failed to update agent config', e);
    process.exit(1);
  });
