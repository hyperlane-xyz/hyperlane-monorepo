import { confirm } from '@inquirer/prompts';

import { ChainName, CoreConfig, EvmCoreModule } from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { log, logBlue, logGray } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import {
  completeDeploy,
  prepareDeploy,
  runPreflightChecksForChains,
} from './utils.js';

/**
 * Executes the core deploy command.
 */
export async function coreDeploy({
  context,
  chain,
  configFilePath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  configFilePath: string;
}) {
  const { signer } = context;
  const config: CoreConfig = readYamlOrJson(configFilePath);

  const deploymentParams: DeployParams = {
    context,
    chain,
    config,
  };

  await runDeployPlanStep(deploymentParams);
  await runPreflightChecksForChains({
    ...deploymentParams,
    chains: [deploymentParams.chain],
    minGas: MINIMUM_CORE_DEPLOY_GAS,
  });

  const userAddress = await signer.getAddress();

  const initialBalances = await prepareDeploy(context, userAddress, [chain]);

  await executeDeploy(deploymentParams);

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);
}

interface DeployParams {
  context: WriteCommandContext;
  chain: ChainName;
  config: CoreConfig;
}

async function runDeployPlanStep({ context, chain }: DeployParams) {
  const { signer, skipConfirmation } = context;
  const address = await signer.getAddress();

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Transaction signer and owner of new contracts will be ${address}`);
  log(`Deploying to ${chain}`);
  log(
    `There are several contracts required for each chain but contracts in your provided registries will be skipped`,
  );

  if (skipConfirmation) return;
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function executeDeploy({ context, chain, config }: DeployParams) {
  logBlue('All systems ready, captain! Beginning deployment...');
  await EvmCoreModule.create({
    chain,
    config,
    multiProvider: context.multiProvider,
  });

  logBlue('Deployment is complete!');
}
