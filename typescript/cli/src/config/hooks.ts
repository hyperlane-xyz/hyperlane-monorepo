import { confirm, input, select } from '@inquirer/prompts';
import { ethers } from 'ethers';
import { z } from 'zod';

import {
  ChainMap,
  ChainName,
  GasOracleContractType,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  MultisigIsmConfig,
  ProtocolFeeHookConfig,
  defaultMultisigIsmConfigs,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import type { Address } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen, logRed } from '../../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigIfExists } from './chain.js';

const ProtocolFeeSchema = z.object({
  type: z.literal(HookType.PROTOCOL_FEE),
  owner: z.string(),
  beneficiary: z.string(),
  maxProtocolFee: z.custom((value) => value instanceof ethers.BigNumber, {
    message: 'maxProtocolFee must be an ethers.BigNumber',
  }),
  protocolFee: z.custom((value) => value instanceof ethers.BigNumber, {
    message: 'protocolFee must be an ethers.BigNumber',
  }),
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
  const gasOracleType: ChainMap<GasOracleContractType> =
    destinationChains.reduce<ChainMap<GasOracleContractType>>((acc, chain) => {
      acc[chain] = GasOracleContractType.StorageGasOracle;
      return acc;
    }, {});
  const overhead = destinationChains.reduce<ChainMap<number>>((acc, chain) => {
    let validatorThreshold, validatorCount;
    if (ismConfig) {
      validatorThreshold = ismConfig.threshold;
      validatorCount = ismConfig.validators.length;
    } else if (local in defaultMultisigIsmConfigs) {
      validatorThreshold = defaultMultisigIsmConfigs[local].threshold;
      validatorCount = defaultMultisigIsmConfigs[local].validators.length;
    } else {
      throw new Error('Cannot estimate gas overhead for IGP hook');
    }
    acc[chain] = multisigIsmVerificationCost(
      validatorThreshold,
      validatorCount,
    );
    return acc;
  }, {});

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
  logGreen('all gucci', result.data);
}

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
  const customChains = readChainConfigIfExists(chainConfigPath);
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
      switch (hookType) {
        case 'merkle_tree': {
          result[chain] = {
            ...result[chain],
            [hookRequirements]: { type: HookType.MERKLE_TREE },
          };
          break;
        }
        case 'protocol_fee': {
          const owner = await input({
            message: 'Enter owner address',
          });
          const ownerAddress = ethers.utils.getAddress(owner);
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
          const beneficiaryAddress = ethers.utils.getAddress(beneficiary);
          // TODO: input in gwei, wei, etc
          const maxProtocolFee = ethers.utils.parseUnits(
            await input({
              message: 'Enter max protocol fee (in 10^18)',
            }),
            'ether',
          );
          const protocolFee = ethers.utils.parseUnits(
            await input({
              message: 'Enter protocol fee (in 10^18)',
            }),
            'ether',
          );
          if (protocolFee.gt(maxProtocolFee)) {
            errorRed('Protocol fee cannot be greater than max protocol fee');
            throw new Error('Invalid protocol fee');
          }

          result[chain] = {
            ...result[chain],
            [hookRequirements]: {
              type: HookType.PROTOCOL_FEE,
              maxProtocolFee: maxProtocolFee,
              protocolFee: protocolFee,
              beneficiary: beneficiaryAddress,
              owner: ownerAddress,
            },
          };
        }
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
