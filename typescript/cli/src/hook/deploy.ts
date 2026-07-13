import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { createHookWriter } from '@hyperlane-xyz/deploy-sdk';
import { GasAction } from '@hyperlane-xyz/provider-sdk';
import { hookConfigToArtifact } from '@hyperlane-xyz/provider-sdk/hook';
import {
  ContractVerifier,
  EvmHookModule,
  ExplorerLicenseType,
  type HookConfig,
  HookType,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, isEVMLike, mustGet } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/apiKeys.js';
import { type WriteCommandContext } from '../context/types.js';
import { validateHookConfigForAltVM } from '../deploy/configValidation.js';
import {
  completeDeploy,
  getBalances,
  runPreflightChecksForChains,
} from '../deploy/utils.js';
import { log, logBlue, logCommandHeader, logGreen } from '../logger.js';
import { writeFileAtPath } from '../utils/files.js';

import { validateAndParseHookConfig } from './config.js';

const UNSUPPORTED_BY_DEPLOY_COMMAND = new Set<string>([
  HookType.RATE_LIMITED,
  HookType.OP_STACK,
  HookType.ARB_L2_TO_L1,
  HookType.CCIP,
]);

function collectHookTypes(config: HookConfig): string[] {
  if (typeof config === 'string') return [];
  const types: string[] = [config.type];
  if (config.type === HookType.AGGREGATION) {
    for (const h of config.hooks) types.push(...collectHookTypes(h));
  } else if (
    config.type === HookType.ROUTING ||
    config.type === HookType.FALLBACK_ROUTING
  ) {
    for (const h of Object.values(config.domains))
      types.push(...collectHookTypes(h));
    if (config.type === HookType.FALLBACK_ROUTING) {
      types.push(...collectHookTypes(config.fallback));
    }
  } else if (config.type === HookType.AMOUNT_ROUTING) {
    types.push(...collectHookTypes(config.lowerHook));
    types.push(...collectHookTypes(config.upperHook));
  }
  return types;
}

interface HookDeployParams {
  context: WriteCommandContext;
  chain: string;
  configPath: string;
  outPath?: string;
}

/**
 * Deploys a hook based on the provided configuration.
 */
export async function runHookDeploy({
  context,
  chain,
  configPath,
  outPath,
}: HookDeployParams): Promise<void> {
  logCommandHeader('Hyperlane Hook Deploy');

  const { multiProvider, registry, skipConfirmation, chainMetadata } = context;

  const { hookConfig, chainAddresses } = await validateAndParseHookConfig({
    configPath,
    chain,
    multiProvider,
    registry,
  });

  for (const type of collectHookTypes(hookConfig)) {
    assert(
      !UNSUPPORTED_BY_DEPLOY_COMMAND.has(type),
      `Hook type ${type} is not supported by 'hook deploy': it requires additional chain or contract context not wired up by this command`,
    );
  }

  // Request API keys for contract verification (unless skipping confirmation)
  let apiKeys: Record<string, string> = {};
  if (!skipConfirmation) {
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);
  }

  // Run preflight checks
  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: GasAction.HOOK_DEPLOY_GAS,
  });

  const initialBalances = await getBalances(context, [chain]);

  logBlue(`Deploying ${hookConfig.type} Hook to ${chain}...`);

  const protocol = multiProvider.getProtocol(chain);
  let deployedAddress: Address;

  if (isEVMLike(protocol)) {
    deployedAddress = await deployEvmHook({
      context,
      chain,
      hookConfig,
      chainAddresses,
      apiKeys,
    });
  } else {
    deployedAddress = await deployNonEvmHook({
      context,
      chain,
      hookConfig,
      chainAddresses,
    });
  }

  logGreen(`\n✅ Hook deployed successfully!`);
  log(`Hook Address: ${deployedAddress}`);
  log(`Chain: ${chain}`);
  log(`Type: ${hookConfig.type}`);

  if (outPath) {
    const output = {
      chain,
      type: hookConfig.type,
      address: deployedAddress,
    };
    writeFileAtPath(outPath, JSON.stringify(output, null, 2) + '\n');
    logGreen(`Output written to ${outPath}`);
  }

  await completeDeploy(context, 'hook', initialBalances, null, [chain]);
}

async function deployEvmHook({
  context,
  chain,
  hookConfig,
  chainAddresses,
  apiKeys,
}: {
  context: WriteCommandContext;
  chain: string;
  hookConfig: Exclude<HookConfig, string>;
  chainAddresses: Record<string, string>;
  apiKeys: Record<string, string>;
}): Promise<Address> {
  const { multiProvider } = context;

  const contractVerifier = new ContractVerifier(
    multiProvider,
    apiKeys,
    coreBuildArtifact,
    ExplorerLicenseType.MIT,
  );

  const proxyFactoryFactories =
    extractIsmAndHookFactoryAddresses(chainAddresses);

  assert(
    chainAddresses.proxyAdmin,
    `No proxyAdmin address found for chain ${chain}`,
  );

  const evmHookModule = await EvmHookModule.create({
    chain,
    multiProvider,
    coreAddresses: {
      mailbox: chainAddresses.mailbox,
      proxyAdmin: chainAddresses.proxyAdmin,
    },
    config: hookConfig,
    proxyFactoryFactories,
    contractVerifier,
  });

  const { deployedHook } = evmHookModule.serialize();
  return deployedHook;
}

async function deployNonEvmHook({
  context,
  chain,
  hookConfig,
  chainAddresses,
}: {
  context: WriteCommandContext;
  chain: string;
  hookConfig: Exclude<HookConfig, string>;
  chainAddresses: Record<string, string>;
}): Promise<Address> {
  const { multiProvider, altVmSigners } = context;

  const signer = mustGet(altVmSigners, chain);
  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);

  const writer = createHookWriter(chainMetadata, chainLookup, signer, {
    mailbox: chainAddresses.mailbox,
  });

  const validatedConfig = validateHookConfigForAltVM(hookConfig, chain);
  const artifact = hookConfigToArtifact(validatedConfig, chainLookup);
  const [deployed] = await writer.create(artifact);
  return deployed.deployed.address;
}
