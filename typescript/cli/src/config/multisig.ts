import { confirm, input, select } from '@inquirer/prompts';

import {
  MultisigConfigMap,
  isValidMultisigConfig,
  readChainConfigIfExists,
} from '../configs.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import { FileFormat, mergeYamlOrJson } from '../utils/files.js';

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
