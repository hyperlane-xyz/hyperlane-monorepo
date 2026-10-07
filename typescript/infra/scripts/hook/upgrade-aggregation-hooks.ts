import { join } from 'path';
import { pathToFileURL } from 'url';
import prompts from 'prompts';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainName,
  ContractVerifier,
  ExplorerLicenseType,
  getDomainId as resolveDomainId,
} from '@hyperlane-xyz/sdk';
import { assert, inCIMode, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { legacyCoreHookRecoveryChains } from '../../config/environments/mainnet3/core.js';
import { supportedChainNames } from '../../config/environments/mainnet3/supportedChainNames.js';
import {
  getChainMetadata,
  getDomainId,
  getEnvAddresses,
} from '../../config/registry.js';
import {
  createFileExportStore,
  createMemoryExportStore,
} from '../../src/aggregation-hook-upgrade/address-export.js';
import { createUpgradeMultiProvider } from '../../src/aggregation-hook-upgrade/provider.js';
import { describeError } from '../../src/aggregation-hook-upgrade/redact.js';
import { runUpgrade } from '../../src/aggregation-hook-upgrade/run.js';
import {
  computeExitCode,
  printSummary,
} from '../../src/aggregation-hook-upgrade/summary.js';
import {
  ChainDomain,
  ChainOutcome,
  UpgradeContext,
  UpgradePersistence,
  UpgradePhase,
} from '../../src/aggregation-hook-upgrade/types.js';
import { chainsToSkip } from '../../src/config/chain.js';
import {
  writeVerificationInputs,
  writeVerificationInputsToFile,
} from '../../src/deployment/verification-inputs.js';
import {
  extractBuildArtifact,
  fetchExplorerApiKeys,
} from '../../src/deployment/verify.js';
import { DEPLOYERS } from '../../src/governance.js';
import { getEnvironmentDirectory } from '../../src/paths.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';
import { writeAndFormatJsonAtPath } from '../../src/utils/utils.js';
import {
  Modules,
  getArgs,
  withChains,
  withContext,
  withFork,
  withYes,
  writeAddresses,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const DEFAULT_OUT_DIR = 'aggregation-hook-upgrade-output';

function parsePhase(value: string): UpgradePhase {
  const phase = Object.values(UpgradePhase).find((known) => known === value);
  assert(phase, `Unknown phase ${value}; expected shadow or prod`);
  return phase;
}

async function main() {
  const {
    environment,
    context = Contexts.Hyperlane,
    phase,
    apply,
    yes,
    fork,
    chains,
    concurrency,
    probeConcurrency,
    outDir,
    buildArtifactPath,
  } = await withYes(
    withFork(
      withChains(
        withContext(
          getArgs()
            .option('phase', {
              type: 'string',
              default: UpgradePhase.Shadow,
              coerce: parsePhase,
              describe:
                'shadow: deploy the fixed aggregation hooks and a new routing hook for test routes (it routes only the supported chains; other destinations use its fallback hook, unlike the production routing hook), or reconcile the recorded one with production, including clearing routes for domains production no longer maps; prod: repoint the existing default routing hook',
            })
            .option('apply', {
              type: 'boolean',
              default: false,
              describe:
                'Send transactions and write registry/export files; without it the run is read-only',
            })
            .option('concurrency', {
              type: 'number',
              default: 4,
              describe: 'Number of chains processed concurrently',
            })
            .option('probeConcurrency', {
              type: 'number',
              default: 16,
              describe: 'Concurrent routing hook reads per chain',
            })
            .option('outDir', {
              type: 'string',
              default: DEFAULT_OUT_DIR,
              describe:
                'Directory for owner transaction files and verification inputs that could not be persisted (fork runs write under <outDir>/fork)',
            })
            .option('buildArtifactPath', {
              type: 'string',
              describe: 'Build artifact used for contract verification',
            }),
        ),
      ),
    ),
  ).argv;

  assert(
    environment === 'mainnet3',
    'This script only supports mainnet3: the domain universe and governance config are mainnet3-specific',
  );
  assert(concurrency > 0, '--concurrency must be greater than 0');
  assert(probeConcurrency > 0, '--probeConcurrency must be greater than 0');
  assert(
    !fork || !chains?.length || (chains.length === 1 && chains[0] === fork),
    '--fork takes a single chain; --chains must be omitted or equal to it',
  );

  const requested: ChainName[] | undefined = fork
    ? [fork]
    : chains?.length
      ? chains
      : undefined;
  const targetChains: ChainName[] = requested ?? [...supportedChainNames];

  const envConfig = getEnvironmentConfig(environment);
  let multiProvider = await createUpgradeMultiProvider({
    envConfig,
    context,
    chains: targetChains,
    signed: apply && !fork,
  });
  if (fork) {
    multiProvider = multiProvider.extendChainMetadata({
      [fork]: { blocks: { confirmations: 0 }, blockExplorers: [] },
    });
    await useLocalProvider(multiProvider, fork);
    multiProvider.setSharedSigner(
      await impersonateAccount(DEPLOYERS[environment]),
    );
  }

  const contractVerifier =
    apply && !fork
      ? new ContractVerifier(
          multiProvider,
          inCIMode() ? {} : await fetchExplorerApiKeys(),
          buildArtifactPath
            ? extractBuildArtifact(buildArtifactPath)
            : coreBuildArtifact,
          ExplorerLicenseType.MIT,
        )
      : undefined;

  const supportedDomains: ChainDomain[] = supportedChainNames.map((chain) => ({
    chain,
    domainId: getDomainId(chain),
  }));
  const registryDomainIds = Object.values(getChainMetadata())
    .filter((metadata) => !metadata.isTestnet)
    .map((metadata) => resolveDomainId(metadata));

  const exportPath = join(
    getEnvironmentDirectory(environment),
    'aggregation-hook-upgrade',
    'addresses.json',
  );
  let verificationWrites: Promise<void> = Promise.resolve();
  const persist: UpgradePersistence = {
    writeRegistryAddresses: (chain, addresses) => {
      if (fork) return;
      writeAddresses(
        environment,
        Modules.PROXY_FACTORY,
        { [chain]: addresses },
        [chain],
      );
    },
    writeVerificationInputs: (module, inputs) => {
      if (fork) return Promise.resolve();
      // The formatter rewrites the file after each write, so concurrent chains
      // must not interleave their read-merge-write cycles.
      const write = verificationWrites.then(() =>
        writeVerificationInputs(environment, module, inputs),
      );
      verificationWrites = write.catch(() => undefined);
      return write;
    },
    writeVerificationRecovery: async (module, chain, inputs) => {
      const file = fork
        ? join(outDir, 'fork', phase, `${chain}.${module}.verification.json`)
        : join(outDir, phase, `${chain}.${module}.verification.json`);
      await writeVerificationInputsToFile(file, { [chain]: inputs });
      return file;
    },
    writeTransactions: async (chain, txs) => {
      const file = fork
        ? join(outDir, 'fork', phase, `${chain}.json`)
        : join(outDir, phase, `${chain}.json`);
      await writeAndFormatJsonAtPath(file, txs);
      return file;
    },
    exportStore: fork
      ? createMemoryExportStore()
      : createFileExportStore(exportPath),
  };

  const logger = rootLogger.child({ module: 'aggregation-hook-upgrade' });
  const buildContext = (applyChanges: boolean): UpgradeContext => ({
    environment,
    phase,
    apply: applyChanges,
    multiProvider,
    chainAddresses: getEnvAddresses(environment),
    supportedDomains,
    registryDomainIds,
    skipLists: {
      legacyCoreHookRecoveryChains,
      chainsToSkip,
    },
    contractVerifier,
    persist,
    concurrency,
    probeConcurrency,
    logger,
    now: () => new Date().toISOString(),
  });

  if (apply && !yes && !fork) {
    const planned = await runUpgrade(buildContext(false), targetChains);
    printSummary(planned, { fork: fork !== undefined });
    const actionable = planned.filter(
      (result) => result.outcome === ChainOutcome.Planned,
    );
    if (actionable.length === 0) {
      process.exitCode = computeExitCode(planned, requested);
      return;
    }
    const { value: confirmed } = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Apply the ${phase} phase to ${actionable.length} chain(s) on ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exitCode = computeExitCode(planned, requested);
      return;
    }
  }

  const results = await runUpgrade(buildContext(apply), targetChains);
  printSummary(results, { fork: fork !== undefined });
  if (apply && !fork) {
    logger.info(`Deployed addresses are recorded in ${exportPath}`);
  }
  process.exitCode = computeExitCode(results, requested);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    rootLogger.error(describeError(error));
    process.exit(1);
  });
}
