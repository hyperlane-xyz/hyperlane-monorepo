import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type HookConfig,
  HookConfigSchema,
  isHookCompatible,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { readYamlOrJson } from '../utils/files.js';

/**
 * Reads, parses, and validates a hook config file for a chain: schema parse,
 * non-address-string check, chain/hook compatibility, and registry address
 * lookup. Shared by `hook deploy` and `hook apply` so the two can't drift.
 */
export async function validateAndParseHookConfig({
  configPath,
  chain,
  multiProvider,
  registry,
}: {
  configPath: string;
  chain: string;
  multiProvider: WriteCommandContext['multiProvider'];
  registry: WriteCommandContext['registry'];
}): Promise<{
  hookConfig: Exclude<HookConfig, string>;
  chainAddresses: ChainAddresses;
}> {
  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = HookConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const hookConfig = parseResult.data;

  assert(
    typeof hookConfig !== 'string',
    'Hook config must be an object, not an address string',
  );

  const { technicalStack } = multiProvider.getChainMetadata(chain);
  assert(
    isHookCompatible({
      hookType: hookConfig.type,
      chainTechnicalStack: technicalStack,
    }),
    `Hook type ${hookConfig.type} is not compatible with chain ${chain} (technical stack: ${technicalStack})`,
  );

  const chainAddresses = await registry.getChainAddresses(chain);
  assert(chainAddresses, `No registry addresses found for chain ${chain}`);
  assert(chainAddresses.mailbox, `No mailbox address found for chain ${chain}`);

  return { hookConfig, chainAddresses };
}
