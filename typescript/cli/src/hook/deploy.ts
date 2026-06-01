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

interface HookDeployParams {
  context: WriteCommandContext;
  chain: string;
  configPath: string;
  outPath?: string;
}

export async function runHookDeploy({
  context,
  chain,
  configPath,
  outPath,
}: HookDeployParams): Promise<void> {
  logCommandHeader('Hyperlane Hook Deploy');

  const { multiProvider, registry, skipConfirmation, chainMetadata } = context;

  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = HookConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid Hook config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const hookConfig: HookConfig = parseResult.data;

  assert(
    typeof hookConfig !== 'string',
    'Hook config must be an object, not an address string',
  );

  const { technicalStack } = multiProvider.getChainMetadata(chain);
  assert(
    isHookCompatible({
      hookType: hookConfig.type,
      chainTechnicalStack: technicalStack,
    }),
    `Hook type ${hookConfig.type} is not compatible with chain ${chain} (technical stack: ${technicalStack})`,
  );

  const chainAddresses = await registry.getChainAddresses(chain);
  assert(chainAddresses, `No registry addresses found for chain ${chain}`);
  assert(chainAddresses.mailbox, `No mailbox address found for chain ${chain}`);

  let apiKeys: Record<string, string> = {};
  if (!skipConfirmation) {
    apiKeys = await requestAndSaveApiKeys([chain], chainMetadata, registry);
  }

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
}: {
  context: WriteCommandContext;
  chain: string;
  hookConfig: Exclude<HookConfig, string>;
}): Promise<Address> {
  const { multiProvider, altVmSigners, registry } = context;

  const signer = mustGet(altVmSigners, chain);
  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);

  const addresses = await registry.getChainAddresses(chain);
  const writer = createHookWriter(chainMetadata, chainLookup, signer, {
    mailbox: addresses?.mailbox,
  });

  const artifact = hookConfigToArtifact(
    hookConfig as ProviderHookConfig,
    chainLookup,
  );
  const result = await writer.create(artifact);
  assert(
    result.length > 0,
    `Hook deployment via writer.create() returned no results for chain ${chain}`,
  );
  return result[0].deployed.address;
}
