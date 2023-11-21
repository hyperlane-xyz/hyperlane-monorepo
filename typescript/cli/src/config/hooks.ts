import { confirm, input, select } from '@inquirer/prompts';
import { BigNumber } from 'bignumber.js';
import { ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  HookConfig,
  HookType,
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

const HookSchema = z.union([ProtocolFeeSchema, MerkleTreeSchema]);

const ConfigSchema = z.object({
  required: HookSchema,
  default: HookSchema,
});
const HookConfigMapSchema = z.object({}).catchall(ConfigSchema);
export type HookConfigMap = z.infer<typeof HookConfigMapSchema>;

export function isValidHookConfigMap(config: any) {
  return HookConfigMapSchema.safeParse(config).success;
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

export function readHookConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) {
    logRed(`No multisig config found at ${filePath}`);
    return;
  }
  const result = HookConfigMapSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;
  const defaultHook: ChainMap<HookConfig> = objMap(
    parsedConfig,
    (_, config) =>
      ({
        type: config.default.type,
      } as HookConfig),
  );
  logGreen(`All multisig configs in ${filePath} are valid`);
  return defaultHook;
}

// TODO: read different hook configs
// export async function readProtocolFeeHookConfig(config: {type: HookType.PROTOCOL_FEE, ...}) {

export async function createHookConfig({
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

  const result: HookConfigMap = {};
  for (const chain of chains) {
    for (const hookRequirements of ['required', 'default']) {
      log(`Setting ${hookRequirements} hook for chain ${chain}`);
      const hookType = await select({
        message: 'Select hook type',
        choices: [
          { value: 'merkle_tree', name: 'MerkleTreeHook' },
          { value: 'protocol_fee', name: 'StaticProtocolFee' },
        ],
        pageSize: 5,
      });
      if (hookType === 'merkle_tree') {
        result[chain] = {
          ...result[chain],
          [hookRequirements]: { type: HookType.MERKLE_TREE },
        };
      } else if (hookType === 'protocol_fee') {
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
            message: 'Enter max protocol fee in (e.g. 1.0)',
          }),
        );
        const protocolFee = toWei(
          await input({
            message: 'Enter protocol fee (e.g. 1.0)',
          }),
        );
        if (BigNumber(protocolFee).gt(maxProtocolFee)) {
          errorRed('Protocol fee cannot be greater than max protocol fee');
          throw new Error('Invalid protocol fee');
        }

        result[chain] = {
          ...result[chain],
          [hookRequirements]: {
            type: HookType.PROTOCOL_FEE,
            maxProtocolFee: maxProtocolFee.toString(),
            protocolFee: protocolFee.toString(),
            beneficiary: beneficiaryAddress,
            owner: ownerAddress,
          },
        };
      } else {
        throw new Error(`Invalid hook type: ${hookType}}`);
      }
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
