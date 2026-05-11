import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { createHookWriter } from '@hyperlane-xyz/deploy-sdk';
import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type HookConfig as ProviderHookConfig,
  hookConfigToArtifact,
} from '@hyperlane-xyz/provider-sdk/hook';
import {
  ContractVerifier,
  EvmHookModule,
  ExplorerLicenseType,
  type HookConfig,
  HookConfigSchema,
  HookType,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
  isHookCompatible,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, isEVMLike, mustGet } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/apiKeys.js';
import { type WriteCommandContext } from '../context/types.js';
import {
  completeDeploy,
  getBalances,
  runPreflightChecksForChains,
} from '../deploy/utils.js';
import { log, logBlue, logCommandHeader, logGreen } from '../logger.js';
import { readYamlOrJson, writeFileAtPath } from '../utils/files.js';

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

  // Read and validate hook config
  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = HookConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid Hook config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const hookConfig: HookConfig = parseResult.data;

  // Validate that config is not just an address
  assert(
    typeof hookConfig !== 'string',
    'Hook config must be an object, not an address string',
  );

  for (const type of collectHookTypes(hookConfig)) {
    assert(
      !UNSUPPORTED_BY_DEPLOY_COMMAND.has(type),
      `Hook type ${type} is not supported by 'hook deploy': it requires additional chain or contract context not wired up by this command`,
    );
  }

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

function toProviderHookConfig(
  config: Exclude<HookConfig, string>,
): ProviderHookConfig {
  switch (config.type) {
    case HookType.MERKLE_TREE:
      return { type: 'merkleTreeHook' };
    case HookType.INTERCHAIN_GAS_PAYMASTER:
      return {
        type: 'interchainGasPaymaster',
        owner: config.owner,
        beneficiary: config.beneficiary,
        oracleKey: config.oracleKey,
        overhead: config.overhead,
        oracleConfig: config.oracleConfig,
      };
    case HookType.PROTOCOL_FEE:
      return {
        type: 'protocolFee',
        owner: config.owner,
        beneficiary: config.beneficiary,
        maxProtocolFee: config.maxProtocolFee,
        protocolFee: config.protocolFee,
      };
    case HookType.UNKNOWN:
      return { type: 'unknownHook' };
    default:
      throw new Error(
        `Hook type '${config.type}' is not supported for non-EVM deployment`,
      );
  }
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

  const artifact = hookConfigToArtifact(
    toProviderHookConfig(hookConfig),
    chainLookup,
  );
  const result = await writer.create(artifact);
  assert(
    result.length > 0,
    `Hook deployment via writer.create() returned no results for chain ${chain}`,
  );
  return result[0].deployed.address;
}
