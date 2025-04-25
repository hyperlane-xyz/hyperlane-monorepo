// eslint-disable-next-line
import fs from 'fs';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  AgentConfig,
  ChainMap,
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

import { Contexts } from '../../config/contexts.js';
import mainnet3GasPrices from '../../config/environments/mainnet3/gasPrices.json' assert { type: 'json' };
import testnet4GasPrices from '../../config/environments/testnet4/gasPrices.json' assert { type: 'json' };
import { getCombinedChainsToScrape } from '../../src/config/agent/scraper.js';
import {
  DeployEnvironment,
  envNameToAgentEnv,
} from '../../src/config/environment.js';
import {
  chainIsProtocol,
  filterRemoteDomainMetadata,
  isEthereumProtocolChain,
  readJSONAtPath,
  writeJsonAtPath,
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
  // Get gas prices for Cosmos chains.
  // Instead of iterating through `addresses`, which only includes EVM chains,
  // iterate through the environment chain names.
  const envAgentConfig = getAgentConfig(Contexts.Hyperlane, environment);
  const environmentChains = envAgentConfig.environmentChainNames;
  const additionalConfig = Object.fromEntries(
    await Promise.all(
      environmentChains
        .filter(
          (chain) =>
            chainIsProtocol(chain, ProtocolType.Cosmos) ||
            chainIsProtocol(chain, ProtocolType.CosmosNative),
        )
        .map(async (chain) => {
          try {
            const gasPrice = await getCosmosChainGasPrice(chain, multiProvider);
            return [chain, { gasPrice }];
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
            return [chain, { gasPrice: { denom, amount } }];
          }
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

  // Manually add contract addresses for Lumia chain
  if (agentConfig.chains['lumia']) {
    agentConfig.chains['lumia'] = {
      ...agentConfig.chains['lumia'],
      interchainGasPaymaster: '0x9024A3902B542C87a5C4A2b3e15d60B2f087Dc3E',
      mailbox: '0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7',
      merkleTreeHook: '0x9c44E6b8F0dB517C2c3a0478caaC5349b614F912',
      validatorAnnounce: '0x989B7307d266151BE763935C856493D968b2affF',
    };
  }

  const filepath = getAgentConfigJsonPath(envNameToAgentEnv[environment]);
  if (fs.existsSync(filepath)) {
    const currentAgentConfig: AgentConfig = readJSONAtPath(filepath);
    // Remove transactionOverrides from each chain in the agent config
    // To ensure all overrides are configured in infra code or the registry, and not in JSON
    for (const chainConfig of Object.values(currentAgentConfig.chains)) {
      delete chainConfig.transactionOverrides;
    }
    writeJsonAtPath(filepath, objMerge(currentAgentConfig, agentConfig));
  } else {
    writeJsonAtPath(filepath, agentConfig);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    rootLogger.error('Failed to update agent config', e);
    process.exit(1);
  });
