#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';

import { Wallet } from 'ethers';
import { parse as parseYaml } from 'yaml';
import yargs from 'yargs';

import { confirm } from '@inquirer/prompts';
import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import { getRegistry } from '../../config/registry.js';

import {
  GCP_DEPLOYER_SECRET,
  GCP_SIGNER_SECRET,
  resolveGcpKey,
} from './oqlf-lib.js';
import {
  STAGING_ARBITRUM_USDC_ROUTER,
  STAGING_BSC_USDT_ROUTER,
} from './deploy-staging-piecewise-fee-lib.js';
import {
  STAGING_LIFECYCLE_LANE_ID,
  withStagingLifecycleRoutes,
} from './piecewise-fee-lifecycle-lib.js';
import {
  EvmLaneOnchainReader,
  type LaneRegistry,
  deduplicatePreparedUpdates,
  discoverPiecewiseLane,
  getLatestBlockTimestamp,
  parsePiecewisePublisherConfig,
  prepareLaneUpdate,
  runPublisherUpdates,
  selectPublisherLanes,
  submitPreparedUpdate,
  verifyPiecewiseSignerAuthorization,
} from './piecewise-fee-lib.js';

const DEFAULT_CONFIG =
  'config/environments/mainnet3/warp/fees/moonpay-staging-piecewise.yaml';

async function main(): Promise<void> {
  const args = await yargs(process.argv.slice(2))
    .option('config', {
      alias: 'c',
      type: 'string',
      default: DEFAULT_CONFIG,
      describe: 'Lane-addressed piecewise curve YAML file',
    })
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://...)',
    })
    .option('mode', {
      choices: ['standing', 'fallback'] as const,
      demandOption: true,
      describe: 'Curve lifecycle to update',
    })
    .option('lane', {
      type: 'string',
      array: true,
      describe: 'Lane id to update; repeat to select multiple lanes',
    })
    .option('submit', {
      type: 'boolean',
      default: false,
      describe: 'Sign and submit the displayed updates',
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      default: false,
      describe: 'Skip the submit confirmation prompt',
    })
    .strict()
    .parseAsync();

  const config = parsePiecewisePublisherConfig(
    parseYaml(await readFile(args.config, 'utf8')),
  );
  const lanes = selectPublisherLanes(config, args.lane, args.mode);
  const registry = args.registry
    ? getMergedRegistry({ registryUris: [args.registry], enableProxy: true })
    : getRegistry();
  const multiProvider = new MultiProvider(await registry.getMetadata());
  const reader = new EvmLaneOnchainReader(multiProvider);
  const updates = deduplicatePreparedUpdates(
    await Promise.all(
      lanes.map(async (lane) =>
        prepareLaneUpdate(
          lane,
          await discoverPiecewiseLane(
            lane.id === STAGING_LIFECYCLE_LANE_ID
              ? withStagingLifecycleRoutes(
                  registry as unknown as LaneRegistry,
                  STAGING_BSC_USDT_ROUTER,
                  STAGING_ARBITRUM_USDC_ROUTER,
                )
              : (registry as unknown as LaneRegistry),
            reader,
            lane,
          ),
          args.mode,
        ),
      ),
    ),
  );

  if (!args.submit) {
    await runPublisherUpdates({
      updates,
      submit: false,
      submitterLabel: '<resolved on submit>',
      getTimestamp: (origin) => getLatestBlockTimestamp(multiProvider, origin),
      log: console.log,
    });
    return;
  }

  const [signerSecret, submitterSecret] = await Promise.all([
    resolveGcpKey(GCP_SIGNER_SECRET),
    resolveGcpKey(GCP_DEPLOYER_SECRET),
  ]);
  const submitter = new Wallet(submitterSecret.privateKey);
  await verifyPiecewiseSignerAuthorization(
    multiProvider,
    signerSecret.privateKey,
    updates,
  );
  if (!args.yes) {
    const approved = await confirm({
      message: `Submit ${updates.length} ${args.mode} update(s) for ${lanes.length} selected lane(s)?`,
      default: false,
    });
    if (!approved) return;
  }

  await runPublisherUpdates({
    updates,
    submit: true,
    submitterLabel: submitter.address,
    getTimestamp: (origin) => getLatestBlockTimestamp(multiProvider, origin),
    log: console.log,
    submitUpdate: async (update) => {
      const result = await submitPreparedUpdate(
        multiProvider,
        signerSecret.privateKey,
        submitter,
        update,
      );
      console.log(
        result.status === 'submitted'
          ? `${update.laneIds.join(',')}: ${result.txHash} confirmed`
          : `${update.laneIds.join(',')}: already installed (no-op)`,
      );
      return result;
    },
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
