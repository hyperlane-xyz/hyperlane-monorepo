import { ethers } from 'ethers';

import {
  ChainMap,
  ChainName,
  CoreConfig,
  EvmCoreModule,
  HyperlaneAddresses,
  HyperlaneCore,
  buildAgentConfig,
} from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGreen } from '../logger.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';
import { writeJson } from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runDeployPlanStep,
  runPreflightChecksForChains,
} from './utils.js';

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
}
/**
 * Executes the core deploy command.
 */
export async function runCoreDeploy({
  context,
  chain,
  config,
  agentOutPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
  agentOutPath: string;
}) {
  const {
    signer,
    isDryRun,
    chainMetadata,
    dryRunChain,
    registry,
    skipConfirmation,
  } = context;

  // Select a dry-run chain if it's not supplied
  if (dryRunChain) {
    chain = dryRunChain;
  } else if (!chain) {
    if (skipConfirmation) throw new Error('No chain provided');
    chain = await runSingleChainSelectionStep(
      chainMetadata,
      'Select chain to connect:',
    );
  }
  const deploymentParams: DeployParams = {
    context,
    chain,
    config,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [chain],
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, [chain]);

  logBlue('All systems ready, captain! Beginning deployment...');
  const evmCoreModule = await EvmCoreModule.create({
    chain,
    config,
    multiProvider: context.multiProvider,
  });

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);
  const deployedAddresses = evmCoreModule.serialize();

  if (!isDryRun) {
    await registry.updateChain({
      chainName: chain,
      addresses: deployedAddresses,
    });

    await writeAgentConfig(context, deployedAddresses, chain, agentOutPath);
  }
  logBlue('Deployment is complete!');
}

async function writeAgentConfig(
  context: WriteCommandContext,
  artifacts: HyperlaneAddresses<any>,
  chain: ChainName,
  outPath: string,
) {
  log('Writing agent configs');
  const { multiProvider, registry } = context;
  const startBlocks: ChainMap<number> = {};
  const core = HyperlaneCore.fromAddressesMap(
    { [chain]: artifacts },
    multiProvider,
  );

  const mailbox = core.getContracts(chain).mailbox;
  startBlocks[chain] = (await mailbox.deployedBlock()).toNumber();

  const chainAddresses = await registry.getAddresses();
  if (!chainAddresses[chain].interchainGasPaymaster) {
    chainAddresses[chain].interchainGasPaymaster = ethers.constants.AddressZero;
  }
  const agentConfig = buildAgentConfig(
    [chain], // Use only the chains that were deployed to
    multiProvider,
    chainAddresses as any,
    startBlocks,
  );
  writeJson(outPath, agentConfig);
  logGreen('Agent configs written');
}
