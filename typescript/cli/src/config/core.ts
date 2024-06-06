import { CoreConfigSchema, HookConfig, IsmConfig } from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { errorRed, logBlue, logGreen } from '../logger.js';
import { detectAndConfirmOrPrompt } from '../utils/chains.js';
import { writeYamlOrJson } from '../utils/files.js';

import {
  createHookConfig,
  createMerkleTreeConfig,
  createProtocolFeeConfig,
} from './hooks.js';
import {
  createIsmConfigWithWarningOrDefault,
  createTrustedRelayerConfig,
} from './ism.js';

export async function createCoreDeployConfig({
  context,
  configFilePath,
  advanced = false,
}: {
  context: CommandContext;
  configFilePath: string;
  advanced: boolean;
}) {
  logBlue('Creating a new core deployment config');

  const owner = await detectAndConfirmOrPrompt(
    async () => context.signer?.getAddress(),
    'Enter the desired',
    'owner address',
  );

  const defaultIsm: IsmConfig = await createIsmConfigWithWarningOrDefault({
    context,
    defaultFn: createTrustedRelayerConfig,
    advanced,
  });

  let defaultHook: HookConfig, requiredHook: HookConfig;
  if (advanced) {
    defaultHook = await createHookConfig(context, 'Select default hook type');
    requiredHook = await createHookConfig(context, 'Select required hook type');
  } else {
    defaultHook = await createMerkleTreeConfig();
    requiredHook = await createProtocolFeeConfig();
  }

  try {
    const coreConfig = CoreConfigSchema.parse({
      owner,
      defaultIsm,
      defaultHook,
      requiredHook,
    });
    logBlue(`Core config is valid, writing to file ${configFilePath}`);
    writeYamlOrJson(configFilePath, coreConfig);
  } catch (e) {
    errorRed(`Core deployment config is invalid.`);
    throw e;
  }

  logGreen('✅ Successfully created new core deployment config');
}
