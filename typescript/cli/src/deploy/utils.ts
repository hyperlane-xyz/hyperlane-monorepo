import { confirm } from '@inquirer/prompts';
import { BigNumber, ethers } from 'ethers';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  IsmConfig,
  MultisigConfig,
  getLocalProvider,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { parseIsmConfig } from '../config/ism.js';
import { MINIMUM_WARP_DEPLOY_GAS } from '../consts.js';
import { TypedSigner } from '../context/strategies/signer/BaseMultiProtocolSigner.js';
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
import { ENV } from '../utils/env.js';

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

  if (!chains?.length) throw new Error('Empty chain selection');
  for (const chain of chains) {
    const metadata = multiProvider.tryGetChainMetadata(chain);
    if (!metadata) throw new Error(`No chain config found for ${chain}`);

    let signer: TypedSigner;

    if (metadata.protocol === ProtocolType.Ethereum) {
      signer = multiProtocolSigner?.getEVMSigner(chain)!;
    }

    switch (metadata.protocol) {
      case ProtocolType.Ethereum:
        signer = multiProtocolSigner!.getEVMSigner(chain);
        break;
      case ProtocolType.Cosmos:
        signer = multiProtocolSigner!.getCosmosNativeSigner(chain);
        break;
      default:
        throw new Error(
          'Only Ethereum and Cosmos chains are supported for now',
        );
    }

    if (!signer) {
      throw new Error('signer is invalid');
    }

    logGreen(`✅ ${metadata.displayName ?? chain} signer is valid`);
  }
  logGreen('✅ Chains are valid');

  await nativeBalancesAreSufficient(
    multiProtocolProvider!,
    multiProtocolSigner!,
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
  const {
    multiProvider,
    multiProtocolSigner,
    multiProtocolProvider,
    isDryRun,
  } = context;
  const initialBalances: Record<string, BigNumber> = {};
  await Promise.all(
    chains.map(async (chain: ChainName) => {
      const protocolType = multiProvider.getProtocol(chain);

      switch (protocolType) {
        case ProtocolType.Ethereum: {
          const provider = isDryRun
            ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
            : multiProtocolProvider?.getEthersV5Provider(chain);
          const address =
            userAddress ??
            (await multiProtocolSigner?.getEVMSigner(chain).getAddress());
          const currentBalance = await provider?.getBalance(address!);
          initialBalances[chain] = currentBalance!;
          break;
        }
        case ProtocolType.Cosmos: {
          const provider =
            await multiProtocolProvider!.getCosmJsProvider(chain);
          const address =
            userAddress ??
            multiProtocolSigner!.getCosmosNativeSigner(chain).account.address;
          const { nativeToken } = multiProvider.getChainMetadata(chain);
          const currentBalance = (
            await provider?.getBalance(address!, nativeToken?.denom!)
          )?.amount;
          initialBalances[chain] = ethers.BigNumber.from(currentBalance);
          break;
        }
      }
    }),
  );
  return initialBalances;
}

export async function completeDeploy(
  context: WriteCommandContext,
  command: string,
  initialBalances: Record<string, BigNumber>,
  userAddress: Address | null,
  chains: ChainName[],
) {
  const { multiProvider, isDryRun } = context;
  if (chains.length > 0) logPink(`⛽️ Gas Usage Statistics`);
  for (const chain of chains) {
    const provider = isDryRun
      ? getLocalProvider(ENV.ANVIL_IP_ADDR, ENV.ANVIL_PORT)
      : multiProvider.getProvider(chain);
    const address =
      userAddress ?? (await multiProvider.getSigner(chain).getAddress());
    const currentBalance = await provider.getBalance(address);
    const balanceDelta = initialBalances[chain].sub(currentBalance);
    if (isDryRun && balanceDelta.lt(0)) break;
    logPink(
      `\t- Gas required for ${command} ${
        isDryRun ? 'dry-run' : 'deploy'
      } on ${chain}: ${ethers.utils.formatEther(balanceDelta)} ${
        multiProvider.getChainMetadata(chain).nativeToken?.symbol ?? 'ETH'
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
