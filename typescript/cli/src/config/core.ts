import { stringify as yamlStringify } from 'yaml';

import { CoreConfigSchema, HookConfig, IsmConfig } from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { indentYamlOrJson, writeYamlOrJson } from '../utils/files.js';
import { detectAndConfirmOrPrompt } from '../utils/input.js';

import {
  createHookConfig,
  createMerkleTreeConfig,
  createProtocolFeeConfig,
} from './hooks.js';
import { createAdvancedIsmConfig, createTrustedRelayerConfig } from './ism.js';

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
    'Enter the desired',
    'owner address',
    'signer',
  );

  const defaultIsm: IsmConfig = advanced
    ? await createAdvancedIsmConfig(context)
    : await createTrustedRelayerConfig(context, advanced);

  let defaultHook: HookConfig, requiredHook: HookConfig;
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
  } else {
    defaultHook = await createMerkleTreeConfig();
    requiredHook = await createProtocolFeeConfig(context, advanced);
  }

  try {
    const coreConfig = CoreConfigSchema.parse({
      owner,
      defaultIsm,
      defaultHook,
      requiredHook,
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
