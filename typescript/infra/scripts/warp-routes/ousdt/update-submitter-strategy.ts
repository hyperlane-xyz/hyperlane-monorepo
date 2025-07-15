import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainSubmissionStrategy,
  TxSubmitterType,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { awSafes } from '../../../config/environments/mainnet3/governance/safe/aw.js';
import { getWarpConfig } from '../../../config/warp.js';
import { Owner, determineGovernanceType } from '../../../src/governance.js';
import { writeYamlAtPath } from '../../../src/utils/utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

const warpRouteId = 'oUSDT/production';
const environment = 'mainnet3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const strategyFilePath = resolve(
  __dirname,
  `../../../config/environments/${environment}/warp/strategies/ousdt.yaml`,
);

const ICA_OWNER_CHAIN = 'ethereum';
const ICA_OWNER_SAFE = awSafes[ICA_OWNER_CHAIN];

async function main() {
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();

  const rawWarpConfig = await getWarpConfig(
    multiProvider,
    envConfig,
    warpRouteId,
  );

  const parsed = WarpRouteDeployConfigSchema.safeParse(rawWarpConfig);
  if (!parsed.success) {
    rootLogger.error('Error parsing warp config:');
    console.dir(rawWarpConfig, { depth: null });
    console.dir(parsed.error.format(), { depth: null });
    return;
  }

  const chainSubmissionStrategy: ChainSubmissionStrategy = {};
  for (const [chain, config] of Object.entries(parsed.data)) {
    const { ownerType } = await determineGovernanceType(chain, config.owner);
    if (ownerType === Owner.SAFE) {
      switch (chain) {
        case 'metis':
        case 'soneium':
        case 'superseed':
        case 'ethereum':
          chainSubmissionStrategy[chain] = {
            submitter: {
              chain,
              type: TxSubmitterType.GNOSIS_TX_BUILDER,
              version: '1.0',
              safeAddress: config.owner,
            },
          };
          break;
        default:
          chainSubmissionStrategy[chain] = {
            submitter: {
              chain,
              type: TxSubmitterType.GNOSIS_SAFE,
              safeAddress: config.owner,
            },
          };
          break;
      }
    }
    // New ICA submitter config from https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/4980
    else if (ownerType === Owner.ICA) {
      chainSubmissionStrategy[chain] = {
        submitter: {
          chain: ICA_OWNER_CHAIN,
          type: 'interchainAccount',
          destinationChain: chain,
          internalSubmitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            version: '1.0',
            safeAddress: ICA_OWNER_SAFE,
          },
          owner: config.owner,
        } as any,
      };
    } else {
      chainSubmissionStrategy[chain] = {
        submitter: {
          chain,
          type: TxSubmitterType.JSON_RPC,
        },
      };
    }
  }

  rootLogger.info('Generated strategy:');
  rootLogger.info(yamlStringify(chainSubmissionStrategy, null, 2));
  rootLogger.info(`Wrote strategy to ${strategyFilePath}`);
  writeYamlAtPath(strategyFilePath, chainSubmissionStrategy);
}

main().catch((err) => rootLogger.error('Error:', err));
