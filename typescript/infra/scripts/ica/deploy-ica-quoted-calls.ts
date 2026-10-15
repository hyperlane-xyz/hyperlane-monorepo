import { join } from 'path';
import { pathToFileURL } from 'url';
import prompts from 'prompts';

import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ChainName,
  ContractVerifier,
  ExplorerLicenseType,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { assert, inCIMode, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getChainMetadata, getEnvAddresses } from '../../config/registry.js';
import {
  createFileChainStore,
  createFileExportStore,
  createMemoryChainStore,
} from '../../src/aggregation-hook-upgrade/address-export.js';
import { createUpgradeMultiProvider } from '../../src/aggregation-hook-upgrade/provider.js';
import { describeError } from '../../src/aggregation-hook-upgrade/redact.js';
import { assertForkable } from '../../src/aggregation-hook-upgrade/protocol.js';
import { writeVerificationInputsToFile } from '../../src/deployment/verification-inputs.js';
import {
  extractBuildArtifact,
  fetchExplorerApiKeys,
} from '../../src/deployment/verify.js';
import { DEPLOYERS } from '../../src/governance.js';
import {
  assertDeployableChains,
  loadFeeTokens,
} from '../../src/ica-quoted-calls-deploy/config.js';
import {
  IcaChainExport,
  IcaChainExportUpdate,
  mergeIcaExport,
} from '../../src/ica-quoted-calls-deploy/export.js';
import { runIcaDeploy } from '../../src/ica-quoted-calls-deploy/run.js';
import {
  createKeyRedactor,
  loadWalletFromEnv,
  parseOwner,
  parsePriorityFeeGwei,
  withPriorityFee,
} from '../../src/ica-quoted-calls-deploy/signer.js';
import {
  computeExitCode,
  printSummary,
} from '../../src/ica-quoted-calls-deploy/summary.js';
import {
  IcaContext,
  IcaOutcome,
  IcaPersistence,
} from '../../src/ica-quoted-calls-deploy/types.js';
import { getEnvironmentDirectory } from '../../src/paths.js';
import { impersonateAccount, useLocalProvider } from '../../src/utils/fork.js';
import {
  Modules,
  getArgs,
  withChains,
  withFork,
  withYes,
  writeAddresses,
} from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const EXPORT_DIRECTORY = 'ica-quoted-calls-test';

async function main() {
  const {
    environment,
    chains,
    apply,
    yes,
    fork,
    keyEnv,
    owner,
    feeTokens: feeTokensPath,
    priorityFeeGwei,
    writeRegistry,
    skipVerification,
    buildArtifactPath,
    concurrency,
  } = await withYes(
    withFork(
      withChains(
        getArgs()
          .option('apply', {
            type: 'boolean',
            default: false,
            describe:
              'Send transactions and write the export; without it the run is a read-only plan',
          })
          .option('key-env', {
            type: 'string',
            describe:
              'Name of the environment variable holding the private key to deploy with (never the key itself); without it the infra deployer role is used',
          })
          .option('owner', {
            type: 'string',
            describe:
              'Final owner of the routers, set as the last step; defaults to the signer',
          })
          .option('fee-tokens', {
            type: 'string',
            describe:
              'YAML or JSON file mapping each chain to its ERC20 fee tokens, e.g. "base: [{ symbol: USDC, address: \'0x...\' }]" with the address quoted; the router allowance is checked and set for each token the IGP prices for the selected destinations. A chain without an entry has none. Without this option no fee tokens are configured and calls can only pay native fees',
          })
          .option('priority-fee-gwei', {
            type: 'string',
            describe:
              'Send with this priority fee and a max fee of twice the base fee above it, instead of the provider suggestion. The fee is fixed from the base fee at the start of the run (read again after the confirmation prompt), so start promptly. Chains whose metadata pins a fee keep it',
          })
          .option('write-registry', {
            type: 'boolean',
            default: false,
            describe:
              'Also write interchainAccountRouterV3 and quotedCallsV3 for fully deployed and wired chains into the local registry checkout; existing v2 addresses are preserved',
          })
          .option('skip-verification', {
            type: 'boolean',
            default: false,
            describe: 'Do not verify the deployed contracts on the explorers',
          })
          .option('build-artifact-path', {
            type: 'string',
            describe: 'Build artifact used for contract verification',
          })
          .option('concurrency', {
            type: 'number',
            default: 4,
            describe: 'Number of chains processed concurrently',
          }),
      ),
    ),
  ).argv;

  assert(
    environment === 'mainnet3' || environment === 'testnet4',
    'This script only supports mainnet3 and testnet4',
  );
  assert(concurrency > 0, '--concurrency must be greater than 0');
  assert(
    !writeRegistry || (apply && fork === undefined),
    '--write-registry needs --apply and cannot be combined with --fork',
  );
  assert(
    keyEnv === undefined || fork === undefined,
    '--key-env cannot be combined with --fork: a fork impersonates the deployer',
  );
  assert(
    !fork || !chains?.length || (chains.length === 1 && chains[0] === fork),
    '--fork takes a single chain; --chains must be omitted or equal to it',
  );
  const targetChains: ChainName[] = fork ? [fork] : (chains ?? []);
  assert(
    targetChains.length > 0,
    '--chains is required unless --fork is given: pass the chains to deploy to',
  );
  const envConfig = getEnvironmentConfig(environment);
  const supported = new Set<string>(envConfig.supportedChainNames);
  for (const chain of targetChains) {
    assert(supported.has(chain), `${chain} is not a ${environment} chain`);
  }
  const chainMetadata = getChainMetadata();
  const registryAddresses = getEnvAddresses(environment);
  assertDeployableChains(targetChains, (chain) => {
    const metadata = chainMetadata[chain];
    assert(metadata, `${chain} has no chain metadata`);
    return {
      protocol: metadata.protocol,
      technicalStack: metadata.technicalStack,
      hasMailbox: registryAddresses[chain]?.mailbox !== undefined,
    };
  });

  const wallet = keyEnv === undefined ? undefined : loadWalletFromEnv(keyEnv);
  const planningSigner = wallet?.address ?? DEPLOYERS[environment];
  const finalOwner = owner === undefined ? undefined : parseOwner(owner);
  const feeTokens: IcaContext['feeTokens'] =
    feeTokensPath === undefined
      ? {}
      : loadFeeTokens(feeTokensPath, targetChains);

  const baseProvider = await createUpgradeMultiProvider({
    envConfig,
    context: Contexts.Hyperlane,
    chains: targetChains,
    signed: apply && !fork && !wallet,
  });
  const logger = rootLogger.child({ module: 'ica-quoted-calls-deploy' });
  if (feeTokensPath === undefined) {
    logger.warn(
      'No --fee-tokens file given: no ERC20 fee tokens are configured, so ICA calls can only pay native fees',
    );
  }
  // The fee parameters follow the base fee at the time of the call, so the
  // provider of the real run is built after the confirmation prompt.
  const prepareProvider = async (applyChanges: boolean) => {
    let multiProvider = baseProvider;
    if (priorityFeeGwei !== undefined) {
      const withFees = await withPriorityFee(
        multiProvider,
        targetChains,
        parsePriorityFeeGwei(priorityFeeGwei),
      );
      multiProvider = withFees.multiProvider;
      if (withFees.pinned.length > 0) {
        logger.warn(
          `--priority-fee-gwei was not applied on ${withFees.pinned.join(', ')}: their metadata pins the fee`,
        );
      }
    }
    if (fork) {
      assertForkable(fork, multiProvider.getChainMetadata(fork).protocol);
      multiProvider = multiProvider.extendChainMetadata({
        [fork]: { blocks: { confirmations: 0 }, blockExplorers: [] },
      });
      await useLocalProvider(multiProvider, fork);
      multiProvider.setSharedSigner(
        await impersonateAccount(DEPLOYERS[environment]),
      );
    } else if (wallet && applyChanges) {
      multiProvider.setSharedSigner(wallet);
    }
    return multiProvider;
  };

  const exportDirectory = join(
    getEnvironmentDirectory(environment),
    EXPORT_DIRECTORY,
  );
  const exportPath = join(exportDirectory, 'addresses.json');
  const verificationPath = join(exportDirectory, 'verification.json');
  const hookExport = createFileExportStore(
    join(
      getEnvironmentDirectory(environment),
      'aggregation-hook-upgrade',
      'addresses.json',
    ),
  );

  // The formatter rewrites the file after each write, so concurrent chains
  // must not interleave their read-merge-write cycles.
  let verificationWrites: Promise<void> = Promise.resolve();
  const persist: IcaPersistence = {
    exportStore: fork
      ? createMemoryChainStore<IcaChainExport, IcaChainExportUpdate>(
          mergeIcaExport,
        )
      : createFileChainStore<IcaChainExport, IcaChainExportUpdate>(
          exportPath,
          mergeIcaExport,
        ),
    writeRegistryAddresses: (chain, addresses) => {
      writeAddresses(
        environment,
        Modules.INTERCHAIN_ACCOUNTS,
        { [chain]: addresses },
        [chain],
      );
    },
    writeVerificationInputs: (chain, inputs) => {
      if (fork) return Promise.resolve();
      const write = verificationWrites.then(() =>
        writeVerificationInputsToFile(verificationPath, { [chain]: inputs }),
      );
      verificationWrites = write.catch(() => undefined);
      return write;
    },
  };

  const buildContext = (
    applyChanges: boolean,
    multiProvider: MultiProvider,
    contractVerifier?: ContractVerifier,
  ): IcaContext => ({
    apply: applyChanges,
    multiProvider,
    chains: targetChains,
    chainAddresses: getEnvAddresses(environment),
    planningSigner,
    owner: finalOwner,
    feeTokens,
    persist,
    writeRegistry,
    contractVerifier,
    readShadowHook: async (chain) =>
      (await hookExport.read(chain))?.shadowRoutingHook,
    redact: createKeyRedactor(wallet),
    concurrency,
    logger,
    now: () => new Date().toISOString(),
  });

  if (apply && !yes && !fork) {
    const planned = await runIcaDeploy(
      buildContext(false, await prepareProvider(false)),
    );
    printSummary(planned);
    const actionable = planned.filter(
      ({ outcome }) => outcome === IcaOutcome.Planned,
    );
    if (actionable.length === 0) {
      process.exitCode = computeExitCode(planned, { apply: true });
      return;
    }
    const { value: confirmed } = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Deploy to ${actionable.length} chain(s) on ${environment}?`,
      initial: false,
    });
    if (!confirmed) {
      process.exitCode = computeExitCode(planned, { apply: true });
      return;
    }
  }

  const runProvider = await prepareProvider(apply);
  const contractVerifier =
    apply && !fork && !skipVerification
      ? new ContractVerifier(
          runProvider,
          inCIMode() ? {} : await fetchExplorerApiKeys(),
          buildArtifactPath
            ? extractBuildArtifact(buildArtifactPath)
            : coreBuildArtifact,
          ExplorerLicenseType.MIT,
        )
      : undefined;
  const results = await runIcaDeploy(
    buildContext(apply, runProvider, contractVerifier),
  );
  printSummary(results);
  if (apply && !fork) {
    logger.info(`Deployed addresses are recorded in ${exportPath}`);
  }
  process.exitCode = computeExitCode(results, { apply });
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
