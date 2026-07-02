/**
 * Deploy a TestRecipient pointing at the fastpath ISM on each fastpath chain
 * and persist the addresses to a JSON file.
 *
 * Usage (dry-run):
 *   yarn tsx scripts/validators/fastpath/deploy-fastpath-test-recipients.ts \
 *     -e mainnet3 --dry-run
 *
 * Usage (deploy):
 *   yarn tsx scripts/validators/fastpath/deploy-fastpath-test-recipients.ts \
 *     -e mainnet3 --key 0x<deployer-private-key> \
 *     [--chains base ethereum ...] \
 *     [--ismsFile config/environments/mainnet3/fastpath/isms.json] \
 *     [--outFile ./test-recipients.json]
 */
import { ethers } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import { TestRecipientDeployer } from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { readJson, writeJson } from '@hyperlane-xyz/utils/fs';

import { join } from 'path';

import { Contexts } from '../../../config/contexts.js';
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
      describe: 'Print config without deploying',
    })
    .option('ismsFile', {
      alias: 'f',
      type: 'string',
      describe: 'Path to isms.json (default: environment fastpath/isms.json)',
    })
    .check((argv) => {
      if (!argv['dry-run'] && !argv.key) {
        throw new Error('--key is required when not using --dry-run');
      }
      return true;
    });
}

async function main() {
  const {
    environment,
    chains,
    key,
    'dry-run': dryRun,
    ismsFile,
    outFile,
  } = await getArgs().argv;

  const ismsFilePath =
    ismsFile ??
    join(
      getInfraPath(),
      getEnvironmentDirectory(environment),
      'fastpath',
      'isms.json',
    );

  const ismAddresses = readJson<Record<string, string>>(ismsFilePath);

  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const targetChains = chains && chains.length > 0 ? chains : fastpathChains;

  for (const chain of targetChains) {
    assert(
      ismAddresses[chain],
      `No fastpath ISM found for ${chain} in ${ismsFilePath}`,
    );
  }

  if (dryRun) {
    rootLogger.info({ targetChains }, 'Dry-run: would deploy TestRecipients');
    const config = Object.fromEntries(
      targetChains.map((c) => [
        c,
        { interchainSecurityModule: ismAddresses[c] },
      ]),
    );
    console.log(yamlStringify(config));
    return;
  }

  assert(key, '--key is required');

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    undefined,
    false,
    targetChains,
  );

  for (const chain of targetChains) {
    multiProvider.setSigner(
      chain,
      new ethers.Wallet(key, multiProvider.getProvider(chain)),
    );
  }

  const deployer = new TestRecipientDeployer(multiProvider);
  const deployed: Record<string, string> = {};

  for (const chain of targetChains) {
    rootLogger.info(
      { chain, fastpathIsm: ismAddresses[chain] },
      'Deploying TestRecipient',
    );
    const { testRecipient } = await deployer.deployContracts(chain, {
      interchainSecurityModule: ismAddresses[chain],
    });
    deployed[chain] = testRecipient.address;
    rootLogger.info({ chain, address: testRecipient.address }, 'Deployed');
  }

  const outputPath =
    outFile ??
    join(
      getInfraPath(),
      getEnvironmentDirectory(environment),
      'fastpath',
      'test-recipients.json',
    );
  writeJson(outputPath, deployed);
  rootLogger.info({ outputPath }, 'Written test recipient addresses');
  console.table(deployed);
}

main().catch(console.error);
