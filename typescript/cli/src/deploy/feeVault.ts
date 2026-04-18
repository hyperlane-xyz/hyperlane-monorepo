import { confirm } from '@inquirer/prompts';
import { BigNumber, Contract } from 'ethers';
import { stringify as yamlStringify } from 'yaml';

import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  EvmWarpFeeVaultModule,
  TokenStandard,
  TokenType,
  type WarpCoreConfig,
  type WarpFeeVaultConfig,
  type WarpRouteDeployConfigMailboxRequired,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  assert,
  isAddressEvm,
  isEVMLike,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import {
  completeDeploy,
  getBalances,
  runPreflightChecksForChains,
} from '../deploy/utils.js';
import { log, logBlue, logGreen } from '../logger.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';
import { getWarpConfigs } from '../utils/warp.js';

export type InferWarpFeeVaultConfigParams = {
  chain: string;
  multiProvider: WriteCommandContext['multiProvider'];
  warpCoreConfig: WarpCoreConfig;
  warpDeployConfig: WarpRouteDeployConfigMailboxRequired;
  owner: Address;
  protocolBeneficiary: Address;
  lpBps: string | number;
  streamingPeriod: string | number;
  name?: string;
  symbol?: string;
  readRouterAsset?: (args: {
    chain: string;
    hubRouter: Address;
    multiProvider: WriteCommandContext['multiProvider'];
  }) => Promise<Address>;
};

export type InferredWarpFeeVaultDeployConfig = {
  chain: string;
  hubRouter: Address;
  routeTokenName: string;
  routeTokenSymbol: string;
  config: WarpFeeVaultConfig;
};

export function defaultWarpFeeVaultName(tokenName: string): string {
  return `${tokenName} Warp Fee Vault`;
}

export function defaultWarpFeeVaultSymbol(tokenSymbol: string): string {
  return `wf${tokenSymbol}`;
}

function formatBigNumberish(value: WarpFeeVaultConfig['lpBps']): string {
  return BigNumber.from(value).toString();
}

function assertSupportedWarpFeeVaultMember({
  chain,
  tokenStandard,
  deployConfigType,
}: {
  chain: string;
  tokenStandard: WarpCoreConfig['tokens'][number]['standard'];
  deployConfigType: WarpRouteDeployConfigMailboxRequired[string]['type'];
}): void {
  const isSupportedMember =
    tokenStandard === TokenStandard.EvmHypCollateral &&
    deployConfigType === TokenType.collateral;

  assert(
    isSupportedMember,
    `Warp fee vault deploy only supports ERC20 collateral warp members on EVM chains. ` +
      `Chain ${chain} has token standard "${tokenStandard}" and deploy config type "${deployConfigType}".`,
  );
}

export async function readWarpRouteAsset({
  chain,
  hubRouter,
  multiProvider,
}: {
  chain: string;
  hubRouter: Address;
  multiProvider: WriteCommandContext['multiProvider'];
}): Promise<Address> {
  const provider = multiProvider.getProvider(chain);
  const router = new Contract(
    hubRouter,
    ['function asset() view returns (address)'],
    provider,
  );
  const asset = (await router.asset()) as string;
  assert(
    isAddressEvm(asset),
    `Invalid asset returned by hub router ${hubRouter} on ${chain}: ${asset}`,
  );
  return asset;
}

export async function inferWarpFeeVaultDeployConfig({
  chain,
  multiProvider,
  warpCoreConfig,
  warpDeployConfig,
  owner,
  protocolBeneficiary,
  lpBps,
  streamingPeriod,
  name,
  symbol,
  readRouterAsset = readWarpRouteAsset,
}: InferWarpFeeVaultConfigParams): Promise<InferredWarpFeeVaultDeployConfig> {
  assert(
    isEVMLike(multiProvider.getProtocol(chain)),
    `Warp fee vault deploy only supports EVM-like chains, got ${multiProvider.getProtocol(chain)} for ${chain}`,
  );

  const token = warpCoreConfig.tokens.find(
    (candidate) => candidate.chainName === chain,
  );
  assert(token, `Chain ${chain} is not part of the selected warp route`);
  assert(
    typeof token.addressOrDenom === 'string' && token.addressOrDenom.length > 0,
    `No deployed warp router found for chain ${chain} in warp route config`,
  );
  assert(
    isAddressEvm(token.addressOrDenom),
    `Warp router for chain ${chain} is not an EVM address: ${token.addressOrDenom}`,
  );
  assert(
    warpDeployConfig[chain],
    `Chain ${chain} is not present in the selected warp deploy config`,
  );
  assertSupportedWarpFeeVaultMember({
    chain,
    tokenStandard: token.standard,
    deployConfigType: warpDeployConfig[chain].type,
  });

  const hubRouter = token.addressOrDenom;
  const asset = await readRouterAsset({ chain, hubRouter, multiProvider });

  return {
    chain,
    hubRouter,
    routeTokenName: token.name,
    routeTokenSymbol: token.symbol,
    config: {
      owner,
      asset,
      hubRouter,
      lpBps,
      protocolBeneficiary,
      streamingPeriod,
      name: name ?? defaultWarpFeeVaultName(token.name),
      symbol: symbol ?? defaultWarpFeeVaultSymbol(token.symbol),
    },
  };
}

export async function runWarpFeeVaultDeploy({
  context,
  chain,
  warpRouteId,
  owner,
  protocolBeneficiary,
  lpBps,
  streamingPeriod,
  name,
  symbol,
  outPath,
}: {
  context: WriteCommandContext;
  chain: string;
  warpRouteId?: string;
  owner: Address;
  protocolBeneficiary: Address;
  lpBps: string | number;
  streamingPeriod: string | number;
  name?: string;
  symbol?: string;
  outPath?: string;
}): Promise<void> {
  const { warpCoreConfig, warpDeployConfig, resolvedWarpRouteId } =
    await getWarpConfigs({
      context,
      warpRouteId,
      chains: [chain],
    });

  const inferred = await inferWarpFeeVaultDeployConfig({
    chain,
    multiProvider: context.multiProvider,
    warpCoreConfig,
    warpDeployConfig,
    owner,
    protocolBeneficiary,
    lpBps,
    streamingPeriod,
    name,
    symbol,
  });

  const deploymentPlan = {
    warpRouteId: resolvedWarpRouteId,
    chain: inferred.chain,
    hubRouter: inferred.hubRouter,
    asset: inferred.config.asset,
    owner: inferred.config.owner,
    protocolBeneficiary: inferred.config.protocolBeneficiary,
    lpBps: formatBigNumberish(inferred.config.lpBps),
    streamingPeriod: formatBigNumberish(inferred.config.streamingPeriod),
    name: inferred.config.name,
    symbol: inferred.config.symbol,
  };

  logBlue('Warp Fee Vault deployment plan:\n');
  log(indentYamlOrJson(yamlStringify(deploymentPlan), 4));

  if (!context.skipConfirmation) {
    const isConfirmed = await confirm({
      message: 'Is this warp fee vault deployment plan correct?',
      default: true,
    });
    assert(isConfirmed, 'Deployment cancelled');
  }

  await runPreflightChecksForChains({
    context,
    chains: [chain],
    minGas: GasAction.WARP_DEPLOY_GAS,
  });

  const signerAddress = await context.multiProvider
    .getSigner(chain)
    .getAddress();
  const initialBalances = await getBalances(context, [chain], signerAddress);

  logBlue(`Deploying warp fee vault to ${chain}...`);
  const module = await EvmWarpFeeVaultModule.create({
    multiProvider: context.multiProvider,
    chain,
    config: inferred.config,
  });

  await completeDeploy(
    context,
    'warp fee vault',
    initialBalances,
    signerAddress,
    [chain],
  );

  const output = {
    address: module.serialize().warpFeeVault,
    ...deploymentPlan,
  };

  logGreen('✅ Warp fee vault deployed successfully!\n');
  log(indentYamlOrJson(yamlStringify(output), 4));

  if (outPath) {
    writeYamlOrJson(outPath, output);
    logGreen(`Output written to ${outPath}`);
  }
}
