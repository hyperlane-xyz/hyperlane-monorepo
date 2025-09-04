import { confirm } from '@inquirer/prompts';
import { BigNumber, ethers } from 'ethers';
import path from 'path';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  CoreConfig,
  IsmConfig,
  IsmType,
  MultisigConfig,
  TypedSigner,
  WarpRouteDeployConfig,
  isIsmCompatible,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { parseIsmConfig } from '../config/ism.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { CommandContext, WriteCommandContext } from '../context/types.js';
import {
  log,
  logBlue,
  logGray,
  logGreen,
  logPink,
  logTable,
} from '../logger.js';
import { nativeBalancesAreSufficient } from '../utils/balances.js';

import { completeDryRun } from './dry-run.js';

export async function runPreflightChecksForChains({
  context,
  chains,
  minGas,
  chainsToGasCheck,
}: {
  context: WriteCommandContext;
  chains: ChainName[];
  minGas: typeof MINIMUM_WARP_DEPLOY_GAS;
  // Chains for which to assert a native balance
  // Defaults to all chains if not specified
  chainsToGasCheck?: ChainName[];
}) {
  log('Running pre-flight checks for chains...');
  const {
    multiProvider,
    skipConfirmation,
    multiProtocolProvider,
    multiProtocolSigner,
  } = context;

  assert(multiProtocolSigner, 'multiProtocolSigner not defined');

  if (!chains?.length) throw new Error('Empty chain selection');
  for (const chain of chains) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);

    const signer = multiProtocolSigner.getSpecificSigner<TypedSigner>(chain);

    if (!signer) {
      throw new Error('signer is invalid');
    }

    logGreen(`✅ ${metadata.displayName ?? chain} signer is valid`);
  }
  logGreen('✅ Chains are valid');

  await nativeBalancesAreSufficient(
    multiProvider,
    multiProtocolProvider,
    multiProtocolSigner,
    chainsToGasCheck ?? chains,
    minGas,
    skipConfirmation,
  );
}

export async function runDeployPlanStep({
  context,
  chain,
}: {
  context: WriteCommandContext;
  chain: ChainName;
}) {
  const {
    chainMetadata: chainMetadataMap,
    multiProvider,
    skipConfirmation,
  } = context;

  const address = await multiProvider.getSigner(chain).getAddress();

  logBlue('\nDeployment plan');
  logGray('===============');
  log(`Transaction signer and owner of new contracts: ${address}`);
  log(`Deploying core contracts to network: ${chain}`);
  const transformedChainMetadata = transformChainMetadataForDisplay(
    chainMetadataMap[chain],
  );
  logTable(transformedChainMetadata);
  log(
    `Note: There are several contracts required for each chain, but contracts in your provided registries will be skipped.`,
  );

  if (skipConfirmation) return;
  await confirmExistingMailbox(context, chain);
  const isConfirmed = await confirm({
    message: 'Is this deployment plan correct?',
  });
  if (!isConfirmed) throw new Error('Deployment cancelled');
}

async function confirmExistingMailbox(
  context: CommandContext,
  chain: ChainName,
) {
  const addresses = await context.registry.getChainAddresses(chain);
  if (addresses?.mailbox) {
    const isConfirmed = await confirm({
      message: `Mailbox already exists at ${addresses.mailbox}. Are you sure you want to deploy a new mailbox and overwrite existing registry artifacts?`,
      default: false,
    });

    if (!isConfirmed) {
      throw Error('Deployment cancelled');
    }
  }
}

// from parsed types
export function isISMConfig(
  config: ChainMap<MultisigConfig> | ChainMap<IsmConfig>,
): boolean {
  return Object.values(config).some((c) => 'type' in c);
}

// directly from filepath
export function isZODISMConfig(filepath: string): boolean {
  return parseIsmConfig(filepath).success;
}

export async function prepareDeploy(
  context: WriteCommandContext,
  userAddress: Address | null,
  chains: ChainName[],
): Promise<Record<string, BigNumber>> {
  const { multiProvider, multiProtocolSigner, isDryRun } = context;
  const initialBalances: Record<string, BigNumber> = {};

  for (const chain of chains) {
    const { nativeToken } = multiProvider.getChainMetadata(chain);
    const address =
      userAddress ?? (await multiProtocolSigner!.getSignerAddress(chain));
    initialBalances[chain] = await multiProtocolSigner!.getBalance({
      isDryRun: isDryRun || false,
      address,
      chain,
      denom: nativeToken?.denom,
    });
  }

  return initialBalances;
}

export async function completeDeploy(
  context: WriteCommandContext,
  command: string,
  initialBalances: Record<string, BigNumber>,
  userAddress: Address | null,
  chains: ChainName[],
) {
  const { multiProvider, isDryRun, multiProtocolSigner } = context;
  assert(multiProtocolSigner, `multiProtocolSigner not defined`);

  if (chains.length > 0) logPink(`⛽️ Gas Usage Statistics`);
  for (const chain of chains) {
    const { nativeToken } = multiProvider.getChainMetadata(chain);
    const address = userAddress
      ? userAddress
      : await multiProtocolSigner.getSignerAddress(chain);
    const currentBalance = await multiProtocolSigner!.getBalance({
      isDryRun: isDryRun || false,
      address,
      chain,
      denom: nativeToken?.denom,
    });
    const balanceDelta = initialBalances[chain].sub(currentBalance);
    if (isDryRun && balanceDelta.lt(0)) break;
    logPink(
      `\t- Gas required for ${command} ${
        isDryRun ? 'dry-run' : 'deploy'
      } on ${chain}: ${ethers.utils.formatEther(balanceDelta)} ${
        nativeToken?.symbol ?? 'UNKNOWN SYMBOL'
      }`,
    );
  }

  if (isDryRun) await completeDryRun(command);
}

function transformChainMetadataForDisplay(chainMetadata: ChainMetadata) {
  return {
    Name: chainMetadata.name,
    'Display Name': chainMetadata.displayName,
    'Chain ID': chainMetadata.chainId,
    'Domain ID': chainMetadata.domainId,
    Protocol: chainMetadata.protocol,
    'JSON RPC URL': chainMetadata.rpcUrls[0].http,
    'Native Token: Symbol': chainMetadata.nativeToken?.symbol,
    'Native Token: Name': chainMetadata.nativeToken?.name,
    'Native Token: Decimals': chainMetadata.nativeToken?.decimals,
  };
}

function validateIsmCompatibility({
  chain,
  ismType,
  context,
}: {
  chain: ChainName;
  ismType?: IsmType;
  context: WriteCommandContext;
}) {
  const { technicalStack: chainTechnicalStack } =
    context.multiProvider.getChainMetadata(chain);

  if (ismType) {
    assert(
      isIsmCompatible({
        ismType,
        chainTechnicalStack,
      }),
      `Selected ISM of type ${ismType} is not compatible with the selected Chain Technical Stack of ${chainTechnicalStack} for chain ${chain}!`,
    );
  }
}

/**
 * Validates that the ISM configuration is compatible with the chain's technical stack.
 * Throws an error if an incompatible ISM type is configured.
 */
export function validateCoreIsmCompatibility(
  chain: ChainName,
  config: CoreConfig,
  context: WriteCommandContext,
) {
  if (typeof config.defaultIsm !== 'string') {
    validateIsmCompatibility({
      chain,
      ismType: config.defaultIsm?.type,
      context,
    });
  }
}

/**
 * Validates that the ISM configurations are compatible with each chain's technical stack.
 * Throws an error if an incompatible ISM type is configured for a chain.
 */
export function validateWarpIsmCompatibility(
  warpRouteConfig: WarpRouteDeployConfig,
  context: WriteCommandContext,
) {
  for (const chain of Object.keys(warpRouteConfig)) {
    const config = warpRouteConfig[chain];

    if (
      config.interchainSecurityModule &&
      typeof config.interchainSecurityModule !== 'string'
    ) {
      validateIsmCompatibility({
        chain,
        ismType: config.interchainSecurityModule.type,
        context,
      });
    }
  }
}

export function warpRouteIdFromFileName(
  filePath: string,
  symbol: string,
): string {
  // Remove the -deploy suffix from the file name in case the input file has it to avoid
  // having file names like this one: *-deploy-config.yaml
  const fileName = path.parse(filePath).name.replace(/-deploy$/, '');
  return createWarpRouteConfigId(symbol, fileName);
}
