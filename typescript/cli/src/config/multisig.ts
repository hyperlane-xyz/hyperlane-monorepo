import { confirm, input } from '@inquirer/prompts';
import { z } from 'zod';

import { ChainMap, MultisigConfig, ZHash } from '@hyperlane-xyz/sdk';
import {
  Address,
  isValidAddress,
  normalizeAddressEvm,
  objMap,
} from '@hyperlane-xyz/utils';

import { sdkContractAddressesMap } from '../context.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson, readYamlOrJson } from '../utils/files.js';

import { readChainConfigsIfExists } from './chain.js';

const MultisigConfigMapSchema = z.object({}).catchall(
  z.object({
    threshold: z.number(),
    validators: z.array(ZHash),
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
  const formattedConfig: ChainMap<MultisigConfig> = objMap(
    parsedConfig,
    (_, config) => {
      if (config.threshold > config.validators.length)
        throw new Error(
          'Threshold cannot be greater than number of validators',
        );
      if (config.threshold < 1)
        throw new Error('Threshold must be greater than 0');
      const validators: Address[] = [];
      for (const v of config.validators) {
        if (isValidAddress(v)) validators.push(normalizeAddressEvm(v));
        else throw new Error(`Invalid address ${v}`);
      }
      return {
        threshold: config.threshold,
        validators: validators,
      } as MultisigConfig;
    },
  );
  logGreen(`All multisig configs in ${filePath} are valid`);
  return formattedConfig;
}

export function isValidMultisigConfig(config: any) {
  return MultisigConfigMapSchema.safeParse(config).success;
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
  log(
    'Select your own chain below to run your own validators. If you want to reuse existing Hyperlane validators instead of running your own, do not select additional mainnet or testnet chains.',
  );
  const customChains = readChainConfigsIfExists(chainConfigPath);
  const chains = await runMultiChainSelectionStep(customChains);

  const result: MultisigConfigMap = {};
  let lastConfig: MultisigConfigMap['string'] | undefined = undefined;
  const repeat = false;
  for (const chain of chains) {
    log(`Setting values for chain ${chain}`);
    if (lastConfig && repeat) {
      result[chain] = lastConfig;
      continue;
    }
    if (Object.keys(sdkContractAddressesMap).includes(chain)) {
      const reuseCoreConfig = await confirm({
        message: 'Use existing Hyperlane validators for this chain?',
      });
      if (reuseCoreConfig) continue;
    }

    const thresholdInput = await input({
      message: 'Enter threshold of signers (number)',
    });
    const threshold = parseInt(thresholdInput, 10);

    const validatorsInput = await input({
      message: 'Enter validator addresses (comma separated list)',
    });
    const validators = validatorsInput.split(',').map((v) => v.trim());
    lastConfig = {
      threshold,
      validators,
    };
    result[chain] = lastConfig;

    // TODO consider re-enabling. Disabling based on feedback from @nambrot for now.
    // repeat = await confirm({
    //   message: 'Use this same config for remaining chains?',
    // });
  }

  if (isValidMultisigConfig(result)) {
    logGreen(`Multisig config is valid, writing to file ${outPath}`);
    mergeYamlOrJson(outPath, result, format);
  } else {
    errorRed(
      `Multisig config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/ism.yaml for an example`,
    );
    throw new Error('Invalid multisig config');
  }
}
