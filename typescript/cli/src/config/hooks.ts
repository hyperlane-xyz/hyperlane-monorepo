import { confirm, input, select } from '@inquirer/prompts';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  HookConfig,
  HookConfigSchema,
  HookType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  normalizeAddressEvm,
  objMap,
  toWei,
} from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen, logRed } from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { readYamlOrJson } from '../utils/files.js';

import { callWithConfigCreationLogs } from './utils.js';

// TODO: deprecate in favor of CoreConfigSchema
const HooksConfigSchema = z.object({
  default: HookConfigSchema,
  required: HookConfigSchema,
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;
const HooksConfigMapSchema = z.record(HooksConfigSchema);
export type HooksConfigMap = z.infer<typeof HooksConfigMapSchema>;

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

export async function createHookConfig(
  context: CommandContext,
  selectMessage = 'Select hook type',
): Promise<HookConfig> {
  const hookType = await select({
    message: selectMessage,
    choices: [
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
        value: HookType.AGGREGATION,
        name: HookType.AGGREGATION,
        description:
          'Aggregate multiple hooks into a single hook (e.g. merkle tree + IGP) which will be called in sequence',
      },
    ],
    pageSize: 10,
  });

  switch (hookType) {
    case HookType.MERKLE_TREE:
      return createMerkleTreeConfig(context);
    case HookType.PROTOCOL_FEE:
      return createProtocolFeeConfig(context);
    case HookType.AGGREGATION:
      return createAggregationConfig(context);
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
  async (): Promise<HookConfig> => {
    const owner = await input({
      message: 'Enter owner address for protocol fee hook',
    });
    const ownerAddress = normalizeAddressEvm(owner);
    let beneficiary;
    let beneficiarySameAsOwner = false;
    beneficiarySameAsOwner = await confirm({
      message: 'Use this same address for the beneficiary?',
    });
    if (beneficiarySameAsOwner) {
      beneficiary = ownerAddress;
    } else {
      beneficiary = await input({
        message: 'Enter beneficiary address for protocol fee hook',
      });
    }
    const beneficiaryAddress = normalizeAddressEvm(beneficiary);
    // TODO: input in gwei, wei, etc
    const maxProtocolFee = toWei(
      await input({
        message: `Enter max protocol fee for protocol fee hook`,
      }),
    );
    const protocolFee = toWei(
      await input({
        message: `Enter protocol fee in for protocol fee hook`,
      }),
    );
    if (BigNumberJs(protocolFee).gt(maxProtocolFee)) {
      errorRed('Protocol fee cannot be greater than max protocol fee');
      throw new Error('Invalid protocol fee');
    }
    return {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: maxProtocolFee.toString(),
      protocolFee: protocolFee.toString(),
      beneficiary: beneficiaryAddress,
      owner: ownerAddress,
    };
  },
  HookType.PROTOCOL_FEE,
);

// TODO: make this usable
export const createIGPConfig = callWithConfigCreationLogs(
  async (remotes: ChainName[]): Promise<HookConfig> => {
    const owner = await input({
      message: 'Enter owner address for IGP hook',
    });
    const ownerAddress = normalizeAddressEvm(owner);
    let beneficiary, oracleKey;
    let beneficiarySameAsOwner = false;
    beneficiarySameAsOwner = await confirm({
      message: 'Use this same address for the beneficiary and gasOracleKey?',
    });
    if (beneficiarySameAsOwner) {
      beneficiary = ownerAddress;
      oracleKey = ownerAddress;
    } else {
      beneficiary = await input({
        message: 'Enter beneficiary address for IGP hook',
      });
      oracleKey = await input({
        message: 'Enter gasOracleKey address for IGP hook',
      });
    }
    const beneficiaryAddress = normalizeAddressEvm(beneficiary);
    const oracleKeyAddress = normalizeAddressEvm(oracleKey);
    const overheads: ChainMap<number> = {};
    for (const chain of remotes) {
      const overhead = parseInt(
        await input({
          message: `Enter overhead for ${chain} (eg 75000) for IGP hook`,
        }),
      );
      overheads[chain] = overhead;
    }
    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary: beneficiaryAddress,
      owner: ownerAddress,
      oracleKey: oracleKeyAddress,
      overhead: overheads,
      oracleConfig: {},
    };
  },
  HookType.INTERCHAIN_GAS_PAYMASTER,
);

export const createAggregationConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<HookConfig> => {
    const hooksNum = parseInt(
      await input({
        message: 'Enter the number of hooks to aggregate (number)',
      }),
      10,
    );
    const hooks: Array<HookConfig> = [];
    for (let i = 0; i < hooksNum; i++) {
      logBlue(`Creating hook ${i + 1} of ${hooksNum} ...`);
      hooks.push(await createHookConfig(context));
    }
    return {
      type: HookType.AGGREGATION,
      hooks,
    };
  },
  HookType.AGGREGATION,
);

export const createRoutingConfig = callWithConfigCreationLogs(
  async (context: CommandContext): Promise<HookConfig> => {
    const owner = await input({
      message: 'Enter owner address for routing ISM',
    });
    const ownerAddress = owner;
    const chains = await runMultiChainSelectionStep(context.chainMetadata);

    const domainsMap: ChainMap<HookConfig> = {};
    for (const chain of chains) {
      await confirm({
        message: `You are about to configure hook for remote chain ${chain}. Continue?`,
      });
      const config = await createHookConfig(context);
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
