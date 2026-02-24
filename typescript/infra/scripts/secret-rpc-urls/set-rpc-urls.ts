import { assert } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/environment.js';
import {
  listAffectedReleases,
  refreshSelectedReleases,
  setRpcUrls,
  setRpcUrlsInteractive,
} from '../../src/utils/rpcUrls.js';
import {
  assertCorrectKubeContext,
  getArgs,
  withChainsRequired,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const {
    environment,
    chains,
    rpcUrls: rpcUrlsJson,
    refreshK8s,
    listReleases,
    refreshReleases,
    yes,
  } = await withChainsRequired(getArgs())
    // For ease of use and backward compatibility, we allow the `chain` argument to be
    // singular or plural.
    .alias('chain', 'chains')
    .option('rpc-urls', {
      type: 'string',
      description:
        'JSON array of RPC URLs for non-interactive mode (e.g. \'["https://url1","https://url2"]\')',
    })
    .option('refresh-k8s', {
      type: 'boolean',
      description: 'Refresh dependent K8s resources after setting URLs',
      default: false,
    })
    .option('list-releases', {
      type: 'boolean',
      description:
        'List affected K8s releases as JSON without making any changes',
      default: false,
    })
    .option('refresh-releases', {
      type: 'string',
      description:
        'Comma-separated list of helm release names to refresh (secrets + pods for services, secrets only for cronjobs)',
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      description: 'Skip confirmation prompts (required with --rpc-urls)',
      default: false,
    }).argv;

  await assertCorrectKubeContext(getEnvironmentConfig(environment));

  if (!chains || chains.length === 0) {
    console.error('No chains provided, Exiting.');
    process.exit(1);
  }

  // --list-releases mode: output JSON list and exit
  if (listReleases) {
    assert(
      chains.length === 1,
      '--list-releases only supports a single chain at a time',
    );
    const releases = await listAffectedReleases(
      environment as DeployEnvironment,
      chains[0],
    );
    console.log(JSON.stringify(releases, null, 2));
    return;
  }

  // --refresh-releases mode: refresh only specified releases
  if (refreshReleases) {
    assert(yes, '--yes is required when using --refresh-releases');
    assert(
      chains.length === 1,
      '--refresh-releases only supports a single chain at a time',
    );
    const releaseNames = refreshReleases
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    assert(releaseNames.length > 0, 'No release names provided');
    await refreshSelectedReleases(
      environment as DeployEnvironment,
      chains[0],
      releaseNames,
    );
    return;
  }

  // Non-interactive mode: set RPC URLs
  if (rpcUrlsJson) {
    assert(yes, '--yes is required when using --rpc-urls');
    assert(
      chains.length === 1,
      '--rpc-urls only supports a single chain at a time',
    );

    let rpcUrls: string[];
    try {
      rpcUrls = JSON.parse(rpcUrlsJson);
    } catch {
      console.error('Failed to parse --rpc-urls as JSON');
      process.exit(1);
    }
    assert(
      Array.isArray(rpcUrls) && rpcUrls.every((u) => typeof u === 'string'),
      '--rpc-urls must be a JSON array of strings',
    );

    const chain = chains[0];
    console.log(
      `Setting RPC URLs for ${chain} (non-interactive): ${JSON.stringify(rpcUrls)}`,
    );
    await setRpcUrls(environment, chain, rpcUrls, { refreshK8s });
    console.log(`Done setting RPC URLs for ${chain}`);
    return;
  }

  // Interactive mode (existing behavior)
  for (const chain of chains) {
    console.log(`Setting RPC URLs for chain: ${chain}`);
    await setRpcUrlsInteractive(environment, chain);
  }
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
