import {
  ChainName,
  CoreConfig,
  DeployedCoreAdresses,
  EvmCoreModule,
} from '@hyperlane-xyz/sdk';

import { MINIMUM_CORE_DEPLOY_GAS } from '../consts.js';
import { WriteCommandContext } from '../context/types.js';
import { readYamlOrJson } from '../utils/files.js';

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
export async function coreDeploy({
  context,
  chain,
  configFilePath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  configFilePath: string;
}): Promise<DeployedCoreAdresses> {
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

  const evmCoreModule = await EvmCoreModule.create({
    chain,
    config,
    multiProvider: context.multiProvider,
  });

  await completeDeploy(context, 'core', initialBalances, userAddress, [chain]);

  return evmCoreModule.serialize();
}
