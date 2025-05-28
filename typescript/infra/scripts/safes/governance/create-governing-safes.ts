import {
  EthersAdapter,
  SafeAccountConfig,
  SafeFactory,
} from '@safe-global/protocol-kit';
import { ethers } from 'ethers';

import { ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import {
  DEPLOYER,
  icas,
  safes,
} from '../../../config/environments/mainnet3/owners.js';
import { Role } from '../../../src/roles.js';
import {
  getInfraPath,
  readJSONAtPath,
  writeJsonAtPath,
} from '../../../src/utils/utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

enum GovernanceSafeType {
  Regular = 'regular',
  Irregular = 'irregular',
  Exceptional = 'exceptional',
}

const safeChainUrls: Record<ChainName, string> = {
  abstract: 'https://abstract-safe.protofire.io/home?safe=abstract',
  arbitrum: 'https://app.safe.global/home?safe=arb1',
  base: 'https://app.safe.global/home?chain=base&safe=base',
  berachain: 'https://safe.berachain.com/home?safe=berachain',
  blast: 'https://app.safe.global/home?safe=blast',
  bsc: 'https://app.safe.global/home?safe=bnb',
  ethereum: 'https://app.safe.global/home?safe=eth',
  fraxtal: 'https://safe.mainnet.frax.com/transactions/queue?safe=fraxtal',
  hyperevm: 'https://wl-hyperliquid-palmera-dao.vercel.app/home?safe=hype',
  linea: 'https://app.safe.global/home?safe=linea',
  mantapacific: 'https://safe.manta.network/transactions/queue?safe=manta',
  mode: 'https://safe.optimism.io/home?safe=mode',
  optimism: 'https://app.safe.global/home?safe=oeth',
  sei: 'https://sei-safe.protofire.io/home?safe=sei',
  sophon: 'https://safe.sophon.xyz/home?safe=sophon',
  swell: 'https://safe.optimism.io/home?safe=swell-l2',
  taiko: 'https://safe.taiko.xyz/home?safe=taiko',
  treasure:
    'https://app.palmeradao.xyz/6751ed2cf70aa4d63124285f/details?safe=treasure%',
  unichain: 'https://app.safe.global/home?safe=unichain',
  zeronetwork:
    'https://safe-whitelabel-git-zero-palmera-dao.vercel.app/settings/setup?safe=ZERϴ',
  zircuit: 'https://safe.zircuit.com/home?safe=zircuit',
  zklink: 'https://safe.zklink.io/home?safe=zklink-nova',
  zksync: 'https://app.safe.global/home?safe=zksync',
};

const GOVERNANCE_SAFES_CONFIG_PATH = `${getInfraPath()}/config/environments/mainnet3/safe/governance-safes.json`;

const createdSafes: Record<ChainName, Record<GovernanceSafeType, string>> = {};

// Get chains that have a safe but not an ICA
const safeOnlyChains = Object.keys(safes).filter((chain) => !(chain in icas));

// Check that all chains with safes have URLs
const chainsWithoutUrls = safeOnlyChains.filter(
  (chain) => !(chain in safeChainUrls),
);
if (chainsWithoutUrls.length > 0) {
  throw new Error(
    `Found chains with safes but no safe URLs: ${chainsWithoutUrls.join(', ')}`,
  );
}

const CHAINS = safeOnlyChains;

async function createSafe(
  chain: string,
  safeType: GovernanceSafeType,
  safeFactory: SafeFactory,
  safeAccountConfig: SafeAccountConfig,
  multiProvider: MultiProvider,
  existingSafes: Record<ChainName, Record<GovernanceSafeType, string>>,
): Promise<string> {
  // Check if safe already exists in config
  if (existingSafes[chain]?.[safeType]) {
    const existingAddress = existingSafes[chain][safeType];
    rootLogger.info(
      `[${chain}][${safeType}]: Safe already exists at "${existingAddress}"`,
    );
    return existingAddress;
  }

  // Create a deterministic salt based on chain and safe type
  const salt = ethers.utils.id(`hyperlane-governance-${safeType}-${chain}`);

  // Predict the address where the safe would be deployed
  const predictedAddress = await safeFactory.predictSafeAddress(
    safeAccountConfig,
    salt,
  );

  rootLogger.info(
    `[${chain}][${safeType}]: Deploying Safe at predicted address "${predictedAddress}"`,
  );
  const safe = await safeFactory.deploySafe({
    safeAccountConfig,
    saltNonce: salt,
  });
  const safeAddress = await safe.getAddress();
  return safeAddress;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    CHAINS,
  );

  // Read existing safes from config
  const existingSafes = readJSONAtPath(GOVERNANCE_SAFES_CONFIG_PATH) as Record<
    ChainName,
    Record<GovernanceSafeType, string>
  >;

  const safeUrlOutputs = {} as Record<
    ChainName,
    Record<GovernanceSafeType, string>
  >;

  rootLogger.info(`Deploying safes for chains: ${CHAINS.join(', ')}`);

  for (const chain of CHAINS) {
    createdSafes[chain] = {} as Record<GovernanceSafeType, string>;
    safeUrlOutputs[chain] = {} as Record<GovernanceSafeType, string>;

    const signer = multiProvider.getSigner(chain);

    const ethAdapter = new EthersAdapter({
      ethers,
      signerOrProvider: signer,
    });

    let safeFactory: SafeFactory;
    try {
      safeFactory = await SafeFactory.create({
        ethAdapter,
      });
    } catch (e) {
      rootLogger.error(`[${chain}]: Error initializing SafeFactory: ${e}`);
      continue;
    }

    const safeAccountConfig: SafeAccountConfig = {
      owners: [DEPLOYER],
      threshold: 1,
    };

    // Create all three types of safes for this chain
    for (const safeType of Object.values(GovernanceSafeType)) {
      try {
        const safeAddress = await createSafe(
          chain,
          safeType,
          safeFactory,
          safeAccountConfig,
          multiProvider,
          existingSafes,
        );
        createdSafes[chain][safeType] = safeAddress;
        safeUrlOutputs[chain][
          safeType
        ] = `${safeChainUrls[chain]}:${safeAddress}`;
      } catch (e) {
        rootLogger.error(`[${chain}][${safeType}]: Error deploying Safe: ${e}`);
      }
    }
  }

  // Log all created safes at the end
  rootLogger.info(JSON.stringify(safeUrlOutputs, null, 2));

  // Write the created safes to the config file, merging with existing safes
  const updatedSafes = {
    ...existingSafes,
    ...createdSafes,
  };
  writeJsonAtPath(GOVERNANCE_SAFES_CONFIG_PATH, updatedSafes);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    rootLogger.error('Failed to create governing safes:', error);
    process.exit(1);
  });
