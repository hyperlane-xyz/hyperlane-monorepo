import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { createHookWriter } from '@hyperlane-xyz/deploy-sdk';
import { GasAction } from '@hyperlane-xyz/provider-sdk';
import { hookConfigToArtifact } from '@hyperlane-xyz/provider-sdk/hook';
import {
  ContractVerifier,
  EvmHookModule,
  ExplorerLicenseType,
  type HookConfig,
  HookConfigSchema,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
  isHookCompatible,
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
import { readYamlOrJson, writeFileAtPath } from '../utils/files.js';

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

  // Read and validate hook config
  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = HookConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const hookConfig: HookConfig = parseResult.data;

  // Validate that config is not just an address
  assert(
    typeof hookConfig !== 'string',
    'Hook config must be an object, not an address string',
  );

  // Validate hook compatibility with chain technical stack
  const { technicalStack } = multiProvider.getChainMetadata(chain);
  assert(
    isHookCompatible({
      hookType: hookConfig.type,
      chainTechnicalStack: technicalStack,
    }),
    `Hook type ${hookConfig.type} is not compatible with chain ${chain} (technical stack: ${technicalStack})`,
  );

  // Get registry addresses for the chain
  const chainAddresses = await registry.getChainAddresses(chain);
  assert(chainAddresses, `No registry addresses found for chain ${chain}`);
  assert(chainAddresses.mailbox, `No mailbox address found for chain ${chain}`);

  // Request API keys for contract verification (unless skipping confirmation)
  let apiKeys: Record<string, string> = {};
  if (!skipConfirmation) {
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);
  }

  // Run preflight checks
  // TODO: introduce a dedicated GasAction.HOOK_DEPLOY_GAS if hook deploys
  // start to diverge from core deploys; reusing CORE_DEPLOY_GAS for now.
  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: GasAction.CORE_DEPLOY_GAS,
  });

  const initialBalances = await getBalances(context, [chain]);

  logBlue(`Deploying ${hookConfig.type} hook to ${chain}...`);

  const protocol = multiProvider.getProtocol(chain);
  const deployedAddress: Address = isEVMLike(protocol)
    ? await deployEvmHook({
        context,
        chain,
        hookConfig,
        chainAddresses,
        apiKeys,
      })
    : await deployNonEvmHook({ context, chain, hookConfig });

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
    config: hookConfig,
    proxyFactoryFactories,
    coreAddresses: {
      mailbox: chainAddresses.mailbox,
      proxyAdmin: chainAddresses.proxyAdmin,
    },
    multiProvider,
    contractVerifier,
  });

  const { deployedHook } = evmHookModule.serialize();
  return deployedHook;
}

async function deployNonEvmHook({
  context,
  chain,
  hookConfig,
}: {
  context: WriteCommandContext;
  chain: string;
  hookConfig: Exclude<HookConfig, string>;
}): Promise<Address> {
  const { multiProvider, altVmSigners, registry } = context;

  const signer = mustGet(altVmSigners, chain);
  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);
  const chainAddresses = await registry.getChainAddresses(chain);

  const writer = createHookWriter(chainMetadata, chainLookup, signer, {
    mailbox: chainAddresses?.mailbox,
  });

  const validatedConfig = validateHookConfigForAltVM(hookConfig, chain);
  const artifact = hookConfigToArtifact(validatedConfig, chainLookup);
  const [deployed] = await writer.create(artifact);
  return deployed.deployed.address;
}
