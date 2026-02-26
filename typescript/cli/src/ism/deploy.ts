import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  createIsmWriter,
  ismConfigToArtifact,
} from '@hyperlane-xyz/deploy-sdk';
import { GasAction, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { type IsmConfig as ProviderIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  ContractVerifier,
  EvmIsmModule,
  ExplorerLicenseType,
  type IsmConfig,
  IsmConfigSchema,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
  isIsmCompatible,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, mustGet } from '@hyperlane-xyz/utils';

import { requestAndSaveApiKeys } from '../context/context.js';
import { type WriteCommandContext } from '../context/types.js';
import {
  completeDeploy,
  getBalances,
  runPreflightChecksForChains,
} from '../deploy/utils.js';
import { log, logBlue, logCommandHeader, logGreen } from '../logger.js';
import { readYamlOrJson, writeFileAtPath } from '../utils/files.js';

interface IsmDeployParams {
  context: WriteCommandContext;
  chain: string;
  configPath: string;
  outPath?: string;
}

/**
 * Deploys an ISM based on the provided configuration.
 */
export async function runIsmDeploy({
  context,
  chain,
  configPath,
  outPath,
}: IsmDeployParams): Promise<void> {
  logCommandHeader('Hyperlane ISM Deploy');

  const { multiProvider, registry, skipConfirmation, chainMetadata } = context;

  // Read and validate ISM config
  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = IsmConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid ISM config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const ismConfig: IsmConfig = parseResult.data;

  // Validate that config is not just an address
  assert(
    typeof ismConfig !== 'string',
    'ISM config must be an object, not an address string',
  );

  // Validate ISM compatibility with chain technical stack
  const { technicalStack } = multiProvider.getChainMetadata(chain);
  assert(
    isIsmCompatible({
      ismType: ismConfig.type,
      chainTechnicalStack: technicalStack,
    }),
    `ISM type ${ismConfig.type} is not compatible with chain ${chain} (technical stack: ${technicalStack})`,
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
    minGas: GasAction.ISM_DEPLOY_GAS,
  });

  const initialBalances = await getBalances(context, [chain]);

  logBlue(`Deploying ${ismConfig.type} ISM to ${chain}...`);

  const protocol = multiProvider.getProtocol(chain);
  let deployedAddress: Address;

  if (protocol === ProtocolType.Ethereum) {
    deployedAddress = await deployEvmIsm({
      context,
      chain,
      ismConfig,
      chainAddresses,
      apiKeys,
    });
  } else {
    deployedAddress = await deployNonEvmIsm({
      context,
      chain,
      ismConfig,
    });
  }

  logGreen(`\n✅ ISM deployed successfully!`);
  log(`ISM Address: ${deployedAddress}`);
  log(`Chain: ${chain}`);
  log(`Type: ${ismConfig.type}`);

  // Write output if requested
  if (outPath) {
    const output = {
      chain,
      type: ismConfig.type,
      address: deployedAddress,
    };
    writeFileAtPath(outPath, JSON.stringify(output, null, 2) + '\n');
    logGreen(`Output written to ${outPath}`);
  }

  await completeDeploy(context, 'ism', initialBalances, null, [chain]);
}

async function deployEvmIsm({
  context,
  chain,
  ismConfig,
  chainAddresses,
  apiKeys,
}: {
  context: WriteCommandContext;
  chain: string;
  ismConfig: Exclude<IsmConfig, string>;
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

  const evmIsmModule = await EvmIsmModule.create({
    chain,
    mailbox: chainAddresses.mailbox,
    multiProvider,
    proxyFactoryFactories,
    config: ismConfig,
    contractVerifier,
  });

  const { deployedIsm } = evmIsmModule.serialize();
  return deployedIsm;
}

async function deployNonEvmIsm({
  context,
  chain,
  ismConfig,
}: {
  context: WriteCommandContext;
  chain: string;
  ismConfig: Exclude<IsmConfig, string>;
}): Promise<Address> {
  const { multiProvider, altVmSigners } = context;

  const signer = mustGet(altVmSigners, chain);
  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);

  const writer = createIsmWriter(chainMetadata, chainLookup, signer);

  // Convert ISM config to artifact format
  const artifact = ismConfigToArtifact(
    // FIXME: not all ISM types are supported yet (treated the same in `warp deploy`)
    ismConfig as ProviderIsmConfig,
    chainLookup,
  );
  const result = await writer.create(artifact);
  assert(
    result.length > 0,
    `ISM deployment via writer.create() returned no results for chain ${chain}`,
  );
  return result[0].deployed.address;
}
