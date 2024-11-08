import { stringify as yamlStringify } from 'yaml';

import {
  CoreConfigSchema,
  HookConfig,
  IsmConfig,
  OwnableConfig,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';

import {
  createHookConfig,
  createMerkleTreeConfig,
  createProtocolFeeConfig,
} from './hooks.js';
import { createAdvancedIsmConfig, createTrustedRelayerConfig } from './ism.js';

const ENTER_DESIRED_VALUE_MSG = 'Enter the desired';
const SIGNER_PROMPT_LABEL = 'signer';

export async function createCoreDeployConfig({
  context,
  configFilePath,
  advanced = false,
}: {
  context: CommandContext;
  configFilePath: string;
  advanced: boolean;
}) {
  logBlue('Creating a new core deployment config...');

  const owner = await detectAndConfirmOrPrompt(
    async () => context.signer?.getAddress(),
    ENTER_DESIRED_VALUE_MSG,
    'owner address',
    SIGNER_PROMPT_LABEL,
  );

  const defaultIsm: IsmConfig = advanced
    ? await createAdvancedIsmConfig(context)
    : await createTrustedRelayerConfig(context, advanced);

  let defaultHook: HookConfig, requiredHook: HookConfig;
  let proxyAdmin: OwnableConfig;
  if (advanced) {
    defaultHook = await createHookConfig({
      context,
      selectMessage: 'Select default hook type',
      advanced,
    });
    requiredHook = await createHookConfig({
      context,
      selectMessage: 'Select required hook type',
      advanced,
    });
    proxyAdmin = {
      owner: await detectAndConfirmOrPrompt(
        async () => context.signer?.getAddress(),
        ENTER_DESIRED_VALUE_MSG,
        'ProxyAdmin owner address',
        SIGNER_PROMPT_LABEL,
      ),
    };
  } else {
    defaultHook = await createMerkleTreeConfig();
    requiredHook = await createProtocolFeeConfig(context, advanced);
    proxyAdmin = {
      owner,
    };
  }

  try {
    const coreConfig = CoreConfigSchema.parse({
      owner,
      defaultIsm,
      defaultHook,
      requiredHook,
      proxyAdmin,
    });
    logBlue(`Core config is valid, writing to file ${configFilePath}:\n`);
    log(indentYamlOrJson(yamlStringify(coreConfig, null, 2), 4));
    writeYamlOrJson(configFilePath, coreConfig, 'yaml');
    logGreen('✅ Successfully created new core deployment config.');
  } catch (e) {
    errorRed(`Core deployment config is invalid.`);
    throw e;
  }
}

export async function readCoreDeployConfigs(filePath: string) {
  const config = readYamlOrJson(filePath);
  return CoreConfigSchema.parse(config);
}
