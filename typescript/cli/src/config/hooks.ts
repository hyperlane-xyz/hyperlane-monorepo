import { confirm, input, select } from '@inquirer/prompts';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { BigNumber, ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  HookConfig,
  HookType,
  HooksConfig,
  IgpHookConfig,
  MerkleTreeHookConfig,
  MultisigIsmConfig,
  ProtocolFeeHookConfig,
  defaultMultisigConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  normalizeAddressEvm,
  objMap,
  toWei,
} from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen, logRed } from '../../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const ProtocolFeeSchema = z.object({
  type: z.literal(HookType.PROTOCOL_FEE),
  owner: z.string(),
  beneficiary: z.string(),
  maxProtocolFee: z.string(),
  protocolFee: z.string(),
});

const MerkleTreeSchema = z.object({
  type: z.literal(HookType.MERKLE_TREE),
});

const IGPSchema = z.object({
  type: z.literal(HookType.INTERCHAIN_GAS_PAYMASTER),
  owner: z.string(),
  beneficiary: z.string(),
  overhead: z.record(z.string()),
  oracleKey: z.string(),
});

const HookConfigSchema = z.union([
  ProtocolFeeSchema,
  MerkleTreeSchema,
  IGPSchema,
]);
export type ZODHookConfig = z.infer<typeof HookConfigSchema>;

const HooksConfigSchema = z.object({
  required: HookConfigSchema,
  default: HookConfigSchema,
});
const HooksConfigMapSchema = z.object({}).catchall(HooksConfigSchema);
export type HooksConfigMap = z.infer<typeof HooksConfigMapSchema>;

export function isValidHookConfigMap(config: any) {
  return HooksConfigMapSchema.safeParse(config).success;
}

export function presetHookConfigs(
  owner: Address,
  local: ChainName,
  destinationChains: ChainName[],
  ismConfig?: MultisigIsmConfig,
) {
  const gasOracleType = destinationChains.reduce<
    ChainMap<GasOracleContractType>
  >((acc, chain) => {
    acc[chain] = GasOracleContractType.StorageGasOracle;
    return acc;
  }, {});
  const overhead = destinationChains.reduce<ChainMap<number>>((acc, chain) => {
    let validatorThreshold: number;
    let validatorCount: number;
    if (ismConfig) {
      validatorThreshold = ismConfig.threshold;
      validatorCount = ismConfig.validators.length;
    } else if (local in defaultMultisigConfigs) {
      validatorThreshold = defaultMultisigConfigs[local].threshold;
      validatorCount = defaultMultisigConfigs[local].validators.length;
    } else {
      throw new Error('Cannot estimate gas overhead for IGP hook');
    }
    acc[chain] = multisigIsmVerificationCost(
      validatorThreshold,
      validatorCount,
    );
    return acc;
  }, {});

  // TODO improve types here to avoid need for `as` casts
  return {
    required: {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei'),
      protocolFee: ethers.utils.parseUnits('0', 'wei'),
      beneficiary: owner,
      owner: owner,
    } as ProtocolFeeHookConfig,
    default: {
      type: HookType.AGGREGATION,
      hooks: [
        {
          type: HookType.MERKLE_TREE,
        } as MerkleTreeHookConfig,
        {
          type: HookType.INTERCHAIN_GAS_PAYMASTER,
          owner: owner,
          beneficiary: owner,
          gasOracleType,
          overhead,
          oracleKey: owner,
        } as IgpHookConfig,
      ],
    },
  };
}

export function readHooksConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) {
    logRed(`No hook config found at ${filePath}`);
    return;
  }
  const result = HooksConfigMapSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;
  const hooks: ChainMap<HooksConfig> = objMap(
    parsedConfig,
    (_, config) =>
      ({
        required: readHookConfig(config.required),
        default: readHookConfig(config.default),
      } as HooksConfig),
  );
  logGreen(`All hook configs in ${filePath} are valid`);
  return hooks;
}

export function readHookConfig(parsedConfig: any): HookConfig {
  if (parsedConfig.type === HookType.PROTOCOL_FEE) {
    return {
      type: parsedConfig.type,
      maxProtocolFee: BigNumber.from(toWei(parsedConfig.protocolFee)),
      protocolFee: BigNumber.from(toWei(parsedConfig.protocolFee)),
      beneficiary: normalizeAddressEvm(parsedConfig.beneficiary),
      owner: normalizeAddressEvm(parsedConfig.owner),
    } as ProtocolFeeHookConfig;
  } else if (parsedConfig.type === HookType.MERKLE_TREE) {
    return {
      type: parsedConfig.type,
    } as MerkleTreeHookConfig;
  } else {
    throw new Error(`Invalid hooker type: ${parsedConfig.type}`);
  }
}

export async function createHookConfigMap({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new hook config');
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(customChains);

  const result: HooksConfigMap = {};
  for (const chain of chains) {
    for (const hookRequirements of ['required', 'default']) {
      log(`Setting ${hookRequirements} hook for chain ${chain}`);
      result[chain] = {
        ...result[chain],
        [hookRequirements]: createHookConfig(chain, chainConfigPath),
      };
    }
    if (isValidHookConfigMap(result)) {
      logGreen(`Hook config is valid, writing to file ${outPath}`);
      mergeYamlOrJson(outPath, result, format);
    } else {
      errorRed(
        `Hook config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/hook-config.yaml for an example`,
      );
      throw new Error('Invalid hook config');
    }
  }
}

export async function createHookConfig(
  _?: ChainName,
  __?: string,
): Promise<ZODHookConfig> {
  let lastConfig: ZODHookConfig;
  const hookType = await select({
    message: 'Select hook type',
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
        value: HookType.INTERCHAIN_GAS_PAYMASTER,
        name: HookType.INTERCHAIN_GAS_PAYMASTER,
        description:
          'Allow for payments for expected gas to be paid by the relayer while delivering on remote chain',
      },
    ],
    pageSize: 5,
  });
  if (hookType === HookType.MERKLE_TREE) {
    lastConfig = { type: HookType.MERKLE_TREE };
  } else if (hookType === HookType.PROTOCOL_FEE) {
    lastConfig = await createProtocolFeeHookConfig();
  } else {
    throw new Error(`Invalid hook type: ${hookType}}`);
  }
  return lastConfig;
}

export async function createProtocolFeeHookConfig(): Promise<ZODHookConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = normalizeAddressEvm(owner);
  let beneficiary;
  let sameAsOwner = false;
  sameAsOwner = await confirm({
    message: 'Use this same address for the beneficiary?',
  });
  if (sameAsOwner) {
    beneficiary = ownerAddress;
  } else {
    beneficiary = await input({
      message: 'Enter beneficiary address',
    });
  }
  const beneficiaryAddress = normalizeAddressEvm(beneficiary);
  // TODO: input in gwei, wei, etc
  const maxProtocolFee = toWei(
    await input({
      message:
        'Enter max protocol fee which you cannot exceed (in eth e.g. 1.0)',
    }),
  );
  const protocolFee = toWei(
    await input({
      message: 'Enter protocol fee (in eth e.g. 0.01)',
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
}

export async function createIGPConfig(
  chain: ChainName,
  chainConfigPath: string,
): Promise<ZODHookConfig> {
  const owner = await input({
    message: 'Enter owner address',
  });
  const ownerAddress = normalizeAddressEvm(owner);
  let beneficiary, oracleKey;
  let sameAsOwner = false;
  sameAsOwner = await confirm({
    message: 'Use this same address for the beneficiary and gasOracleKey?',
  });
  if (sameAsOwner) {
    beneficiary = ownerAddress;
    oracleKey = ownerAddress;
  } else {
    beneficiary = await input({
      message: 'Enter beneficiary address',
    });
    oracleKey = await input({
      message: 'Enter gasOracleKey address',
    });
  }
  const beneficiaryAddress = normalizeAddressEvm(beneficiary);
  const oracleKeyAddress = normalizeAddressEvm(oracleKey);
  const customChains = readChainConfigsIfExists(chainConfigPath);
  delete customChains[chain];
  const chains = await runMultiChainSelectionStep(
    customChains,
    `Select destination chains to pay overhead from ${chain}`,
    [chain],
  );
  const overheads: ChainMap<string> = {};
  for (const chain of chains) {
    const overhead = await input({
      message: `Enter overhead for ${chain} (in eth e.g. 0.01)`,
    });
    overheads[chain] = toWei(overhead);
  }

  return {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    beneficiary: beneficiaryAddress,
    owner: ownerAddress,
    oracleKey: oracleKeyAddress,
    overhead: overheads,
  };
}
