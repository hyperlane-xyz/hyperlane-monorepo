/**
 * Deploy fastpath aggregation ISMs (merkleRootMultisig + messageIdMultisig, threshold 1-of-2)
 * on each fastpath chain. Chains default to those in the fastpath agent config.
 *
 * Dry-run:  prints ISM config per chain, no on-chain calls.
 * Live run: deploys via the proxy factory using the provided --key.
 *
 * Usage (dry-run):
 *   yarn tsx scripts/validators/fastpath/deploy-fastpath-isms.ts \
 *     -e mainnet3 --dry-run --validators 0x...
 *
 * Usage (deploy):
 *   yarn tsx scripts/validators/fastpath/deploy-fastpath-isms.ts \
 *     -e mainnet3 --key 0x<deployer-private-key> \
 *     [--chains arbitrum base ...] \
 *     --validators 0x... [0x...] \
 *     [--threshold N] \             # defaults to validator count
 *     [--outFile ./fastpath-isms.json]
 */
import { ethers } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import {
  AggregationIsmConfig,
  HyperlaneIsmFactory,
  IsmType,
  MultisigIsmConfig,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { writeJson } from '@hyperlane-xyz/utils/fs';

import { join } from 'path';

import { Contexts } from '../../../config/contexts.js';
import { getChainAddresses } from '../../../config/registry.js';
import { getEnvironmentDirectory } from '../../../src/paths.js';
import { getInfraPath } from '../../../src/utils/utils.js';
import {
  getAgentConfig,
  getArgs as getBaseArgs,
  withChains,
  withOutputFile,
} from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

function getArgs() {
  return withOutputFile(withChains(getBaseArgs()))
    .option('key', {
      type: 'string',
      describe: 'Deployer private key (required unless --dry-run)',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Print ISM configs without deploying',
    })
    .describe('validators', 'fastpath validator addresses')
    .string('validators')
    .array('validators')
    .demandOption('validators')
    .describe(
      'threshold',
      'threshold for each sub-ISM (defaults to validator count)',
    )
    .number('threshold')
    .check((argv) => {
      if (!argv['dry-run'] && !argv.key) {
        throw new Error('--key is required when not using --dry-run');
      }
      return true;
    });
}

function buildIsmConfig(
  validators: string[],
  threshold: number,
): AggregationIsmConfig {
  const merkleRoot: MultisigIsmConfig = {
    type: IsmType.MERKLE_ROOT_MULTISIG,
    validators,
    threshold,
  };
  const messageId: MultisigIsmConfig = {
    type: IsmType.MESSAGE_ID_MULTISIG,
    validators,
    threshold,
  };
  return {
    type: IsmType.AGGREGATION,
    modules: [merkleRoot, messageId],
    threshold: 1,
  };
}

async function main() {
  const {
    environment,
    chains,
    key,
    'dry-run': dryRun,
    validators,
    threshold,
    outFile,
  } = await getArgs().argv;

  const fastPathAgentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastPathChains = fastPathAgentConfig.contextChainNames.validator;
  const targetChains = chains && chains.length > 0 ? chains : fastPathChains;

  const validatorList = validators;
  const resolvedThreshold = threshold ?? validatorList.length;
  const ismConfig = buildIsmConfig(validatorList, resolvedThreshold);

  if (dryRun) {
    rootLogger.info(
      { targetChains },
      'Dry-run: ISM config (same for all chains)',
    );
    console.log(yamlStringify(ismConfig));
    console.log(`\nWould deploy to: ${targetChains.join(', ')}`);
    return;
  }

  assert(key, '--key is required');

  rootLogger.info(
    { targetChains, validators: validatorList, threshold: resolvedThreshold },
    'Deploying fastpath aggregation ISMs',
  );

  const envConfig = getEnvironmentConfig(environment);
  // Get a read-only multi-provider (no GCP key lookup), then attach the deployer wallet.
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    undefined,
    false,
    targetChains,
  );

  for (const chain of targetChains) {
    const provider = multiProvider.getProvider(chain);
    const wallet = new ethers.Wallet(key, provider);
    multiProvider.setSigner(chain, wallet);
  }

  const ismFactory = HyperlaneIsmFactory.fromAddressesMap(
    getChainAddresses(),
    multiProvider,
  );

  const deployedIsms: Record<string, string> = {};

  for (const chain of targetChains) {
    rootLogger.info({ chain }, 'Deploying aggregation ISM');
    const ism = await ismFactory.deploy({
      destination: chain,
      config: ismConfig,
    });
    deployedIsms[chain] = ism.address;
    rootLogger.info({ chain, address: ism.address }, 'Deployed');
  }

  const outputPath =
    outFile ??
    join(
      getInfraPath(),
      getEnvironmentDirectory(environment),
      'fastpath',
      'isms.json',
    );
  writeJson(outputPath, deployedIsms);
  rootLogger.info({ outputPath }, 'Written ISM addresses');
  console.table(deployedIsms);
}

main().catch(console.error);
