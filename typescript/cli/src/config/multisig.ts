import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';

import { ChainMap, ModuleType, MultisigIsmConfig } from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { errorRed, log, logBlue, logGreen } from '../../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigIfExists } from './chain.js';

const MultisigConfigMapSchema = z.object({}).catchall(
  z.object({
    type: z.string(),
    threshold: z.number(),
    validators: z.array(z.string()),
  }),
);
export type MultisigConfigMap = z.infer<typeof MultisigConfigMapSchema>;

export function readMultisigConfig(filePath: string) {
  const config = readYamlOrJson(filePath);
  if (!config) throw new Error(`No multisig config found at ${filePath}`);
  const result = MultisigConfigMapSchema.safeParse(config);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `Invalid multisig config: ${firstIssue.path} => ${firstIssue.message}`,
    );
  }
  const parsedConfig = result.data;
  const formattedConfig = objMap(parsedConfig, (_, config) => ({
    ...config,
    type: humanReadableIsmTypeToEnum(config.type),
  }));

  logGreen(`All multisig configs in ${filePath} are valid`);
  return formattedConfig as ChainMap<MultisigIsmConfig>;
}

export function isValidMultisigConfig(config: any) {
  return MultisigConfigMapSchema.safeParse(config).success;
}

function humanReadableIsmTypeToEnum(type: string): ModuleType {
  for (const [key, value] of Object.entries(ModuleType)) {
    if (key.toLowerCase() === type) return parseInt(value.toString(), 10);
  }
  throw new Error(`Invalid ISM type ${type}`);
}

export async function createMultisigConfig({
  format,
  outPath,
  chainConfigPath,
}: {
  format: FileFormat;
  outPath: string;
  chainConfigPath: string;
}) {
  logBlue('Creating a new multisig config');
  const customChains = readChainConfigIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(customChains);

  const result: MultisigConfigMap = {};
  let lastConfig: MultisigConfigMap['string'] | undefined = undefined;
  let repeat = false;
  for (const chain of chains) {
    log(`Setting values for chain ${chain}`);
    if (lastConfig && repeat) {
      result[chain] = lastConfig;
      continue;
    }
    // TODO consider using default and not offering options here
    // legacy_multisig is being deprecated in v3
    // Default should probably be aggregation(message_id, merkle_root)
    const moduleType = await select({
      message: 'Select multisig type',
      choices: [
        // { value: 'routing, name: 'routing' }, // TODO add support
        // { value: 'aggregation, name: 'aggregation' }, // TODO add support
        { value: 'legacy_multisig', name: 'legacy multisig' },
        { value: 'merkle_root_multisig', name: 'merkle root multisig' },
        { value: 'message_id_multisig', name: 'message id multisig' },
      ],
      pageSize: 5,
    });

    const thresholdInput = await input({
      message: 'Enter threshold of signers (number)',
    });
    const threshold = parseInt(thresholdInput, 10);

    const validatorsInput = await input({
      message: 'Enter validator addresses (comma separated list)',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());
    lastConfig = {
      type: moduleType,
      threshold,
      validators,
    };
    result[chain] = lastConfig;

    repeat = await confirm({
      message: 'Use this same config for remaining chains?',
    });
  }

  if (isValidMultisigConfig(result)) {
    logGreen(`Multisig config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `Multisig config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/multisig-ism.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}
