import { confirm, input, select } from '@inquirer/prompts';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainGasOracleParams,
  ChainMap,
  ChainMetadata,
  HookConfig,
  HookConfigSchema,
  HookType,
  IgpHookConfig,
  MultiProtocolProvider,
  getCoingeckoTokenPrices,
  getGasPrice,
  getLocalStorageGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  normalizeAddressEvm,
  objFilter,
  objMap,
  toWei,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, logRed } from '../logger.js';
import {
  runMultiChainSelectionStep,
  runSingleChainSelectionStep,
} from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';
import { detectAndConfirmOrPrompt, inputWithInfo } from '../utils/input.js';

import { callWithConfigCreationLogs } from './utils.js';

// TODO: deprecate in favor of CoreConfigSchema
const HooksConfigSchema = z.object({
  default: HookConfigSchema,
  required: HookConfigSchema,
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
const HooksConfigMapSchema = z.record(HooksConfigSchema);
export type HooksConfigMap = z.infer<typeof HooksConfigMapSchema>;

const MAX_PROTOCOL_FEE_DEFAULT: string = toWei('0.1');
const PROTOCOL_FEE_DEFAULT: string = toWei('0');

export function presetHookConfigs(owner: Address): HooksConfig {
  return {
    required: {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(),
      protocolFee: ethers.utils.parseUnits('0', 'wei').toString(),
      beneficiary: owner,
      owner: owner,
    },
    default: {
      type: HookType.MERKLE_TREE,
    },
  };
}

export function readHooksConfigMap(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) {
    logRed(`No hook config found at ${filePath}`);
    return;
  }
  const parsedConfig = HooksConfigMapSchema.parse(config);
  const hooks: ChainMap<HooksConfig> = objMap(
    parsedConfig,
    (_, config) => config as HooksConfig,
  );
  logGreen(`All hook configs in ${filePath} are valid for ${hooks}`);
  return hooks;
}

export async function createHookConfig({
  context,
  selectMessage = 'Select hook type',
  advanced = false,
}: {
  context: CommandContext;
  selectMessage?: string;
  advanced?: boolean;
}): Promise<HookConfig> {
  const hookType = await select({
    message: selectMessage,
    choices: [
      {
        value: HookType.AGGREGATION,
        name: HookType.AGGREGATION,
        description:
          'Aggregate multiple hooks into a single hook (e.g. merkle tree + IGP) which will be called in sequence',
      },
      {
        value: HookType.MERKLE_TREE,
        name: HookType.MERKLE_TREE,
        description:
          'Add messages to the incremental merkle tree on origin chain (needed for the merkleRootMultisigIsm on the remote chain)',
      },
      {
        value: HookType.PROTOCOL_FEE,
        name: HookType.PROTOCOL_FEE,
        description: 'Charge fees for each message dispatch from this chain',
      },
      {
        value: HookType.INTERCHAIN_GAS_PAYMASTER,
        name: HookType.INTERCHAIN_GAS_PAYMASTER,
        description: 'Pay for gas on remote chains',
      },
    ],
    pageSize: 10,
  });

  switch (hookType) {
    case HookType.AGGREGATION:
      return createAggregationConfig(context, advanced);
    case HookType.MERKLE_TREE:
      return createMerkleTreeConfig();
    case HookType.PROTOCOL_FEE:
      return createProtocolFeeConfig(context, advanced);
    case HookType.INTERCHAIN_GAS_PAYMASTER:
      return createIGPConfig(context, advanced);
    default:
      throw new Error(`Invalid hook type: ${hookType}`);
  }
}

export const createMerkleTreeConfig = callWithConfigCreationLogs(
  async (): Promise<HookConfig> => {
    return { type: HookType.MERKLE_TREE };
  },
  HookType.MERKLE_TREE,
);

export const createProtocolFeeConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<HookConfig> => {
    const unnormalizedOwner =
      !advanced && context.signer
        ? await context.signer.getAddress()
        : await detectAndConfirmOrPrompt(
            async () => context.signer?.getAddress(),
            'For protocol fee hook, enter',
            'owner address',
            'signer',
          );
    const owner = normalizeAddressEvm(unnormalizedOwner);
    let beneficiary = owner;

    const isBeneficiarySameAsOwner = advanced
      ? await confirm({
          message: `Use this same address (${owner}) for the beneficiary?`,
        })
      : true;

    if (!isBeneficiarySameAsOwner) {
      const unnormalizedBeneficiary = await input({
        message: 'Enter beneficiary address for protocol fee hook:',
      });
      beneficiary = normalizeAddressEvm(unnormalizedBeneficiary);
    }
    // TODO: input in gwei, wei, etc
    const maxProtocolFee = advanced
      ? toWei(
          await inputWithInfo({
            message: `Enter max protocol fee for protocol fee hook (wei):`,
            info: `The max protocol fee (ProtocolFee.MAX_PROTOCOL_FEE) is the maximum value the protocol fee on the ProtocolFee hook contract can ever be set to.\nDefault is set to ${MAX_PROTOCOL_FEE_DEFAULT} wei; between 0.001 and 0.1 wei is recommended.`,
          }),
        )
      : MAX_PROTOCOL_FEE_DEFAULT;
    const protocolFee = advanced
      ? toWei(
          await inputWithInfo({
            message: `Enter protocol fee for protocol fee hook (wei):`,
            info: `The protocol fee is the fee collected by the beneficiary of the ProtocolFee hook for every transaction executed with this hook.\nDefault is set to 0 wei; must be less than max protocol fee of ${maxProtocolFee}.`,
          }),
        )
      : PROTOCOL_FEE_DEFAULT;
    if (BigNumberJs(protocolFee).gt(maxProtocolFee)) {
      errorRed(
        `Protocol fee (${protocolFee}) cannot be greater than max protocol fee (${maxProtocolFee}).`,
      );
      throw new Error(`Invalid protocol fee (${protocolFee}).`);
    }
    return {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee,
      protocolFee,
      beneficiary,
      owner,
    };
  },
  HookType.PROTOCOL_FEE,
);

export const createIGPConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<IgpHookConfig> => {
    const unnormalizedOwner =
      !advanced && context.signer
        ? await context.signer.getAddress()
        : await detectAndConfirmOrPrompt(
            async () => context.signer?.getAddress(),
            'For Interchain Gas Paymaster, enter',
            'owner address',
            'signer',
          );
    const owner = normalizeAddressEvm(unnormalizedOwner);
    const oracleKey = owner;

    let beneficiary = owner;
    const beneficiarySameAsOwner = await confirm({
      message: 'Use this same address for the beneficiary?',
    });
    if (!beneficiarySameAsOwner) {
      const unnormalizedBeneficiary = await input({
        message: 'Enter beneficiary address for IGP hook',
      });
      beneficiary = normalizeAddressEvm(unnormalizedBeneficiary);
    }

    const localChain = await runSingleChainSelectionStep(
      context.chainMetadata,
      'Select local chain for IGP hook',
    );
    const isTestnet = context.chainMetadata[localChain].isTestnet;
    const remoteChains = await runMultiChainSelectionStep(
      objFilter(
        context.chainMetadata,
        (_, metadata): metadata is ChainMetadata =>
          metadata.name !== localChain,
      ),
      'Select remote destination chains for IGP hook',
      1,
      isTestnet ? 'testnet' : 'mainnet',
    );

    // Only need to set overhead for remote chains
    const overhead: ChainMap<number> = {};
    for (const chain of remoteChains) {
      overhead[chain] = parseInt(
        await input({
          message: `Enter overhead for ${chain} (e.g., 75000) for IGP hook`,
          default: '75000',
        }),
      );
    }

    // Restrict metadata to only the chains that are part of the IGP hook
    const filteredMetadata = objFilter(
      context.chainMetadata,
      (_, metadata): metadata is ChainMetadata =>
        remoteChains.includes(metadata.name) || metadata.name === localChain,
    );

    // Fetch prices for all chains in the IGP hook
    // For testnet, hardcode prices to 10 USD
    // For mainnet, fetch prices from Coingecko
    // If mainnet prices are not found, user will be prompted to enter them
    let fetchedPrices: ChainMap<string | undefined> = {};
    if (isTestnet) {
      // Get the prices of the remote chains' tokens from Coingecko
      logBlue(`Hardcoding all gas token prices to 10 USD for testnet...`);
      fetchedPrices = objMap(filteredMetadata, () => '10');
    } else {
      // Get the prices of the remote chains' tokens from Coingecko
      logBlue(`Getting gas token prices for all chains from Coingecko...`);
      fetchedPrices = await getCoingeckoTokenPrices(filteredMetadata);
    }

    const mpp = new MultiProtocolProvider(context.chainMetadata);
    const prices: ChainMap<ChainGasOracleParams> = {};

    for (const chain of Object.keys(filteredMetadata)) {
      const gasPrice = await getGasPrice(mpp, chain);
      logBlue(`Gas price for ${chain} is ${gasPrice.amount}`);

      // if the price is not found on Coingecko, prompt user to enter it
      let tokenPrice = fetchedPrices[chain];
      if (!tokenPrice) {
        tokenPrice = await input({
          message: `Enter the price of ${chain}'s token in USD`,
        });
      } else {
        logBlue(`Gas token price for ${chain} is $${tokenPrice}`);
      }

      const decimals = context.chainMetadata[chain].nativeToken?.decimals;
      if (!decimals) {
        throw new Error(`No decimals found in metadata for ${chain}`);
      }
      prices[chain] = {
        gasPrice,
        nativeToken: { price: tokenPrice, decimals },
      };
    }

    // Allow user to enter a IGP exchange rate margin in %
    const exchangeRateMarginPct = parseInt(
      await input({
        message: `Enter IGP margin percentage (e.g. 10 for 10%)`,
        default: '10',
      }),
    );

    const oracleConfig = getLocalStorageGasOracleConfig(
      localChain,
      prices,
      exchangeRateMarginPct,
    );

    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary,
      owner,
      oracleKey,
      overhead,
      oracleConfig,
    };
  },
  HookType.INTERCHAIN_GAS_PAYMASTER,
);

export const createAggregationConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<HookConfig> => {
    const hooksNum = parseInt(
      await input({
        message: 'Enter the number of hooks to aggregate (number)',
      }),
      10,
    );
    const hooks: Array<HookConfig> = [];
    for (let i = 0; i < hooksNum; i++) {
      logBlue(`Creating hook ${i + 1} of ${hooksNum} ...`);
      hooks.push(
        await createHookConfig({
          context,
          advanced,
        }),
      );
    }
    return {
      type: HookType.AGGREGATION,
      hooks,
    };
  },
  HookType.AGGREGATION,
);

export const createRoutingConfig = callWithConfigCreationLogs(
  async (
    context: CommandContext,
    advanced: boolean = false,
  ): Promise<HookConfig> => {
    const owner = await input({
      message: 'Enter owner address for routing Hook',
    });
    const ownerAddress = owner;
    const chains = await runMultiChainSelectionStep(
      context.chainMetadata,
      'Select chains for routing Hook',
      1,
    );

    const domainsMap: ChainMap<HookConfig> = {};
    for (const chain of chains) {
      await confirm({
        message: `You are about to configure hook for remote chain ${chain}. Continue?`,
      });
      const config = await createHookConfig({ context, advanced });
      domainsMap[chain] = config;
    }
    return {
      type: HookType.ROUTING,
      owner: ownerAddress,
      domains: domainsMap,
    };
  },
  HookType.ROUTING,
);
