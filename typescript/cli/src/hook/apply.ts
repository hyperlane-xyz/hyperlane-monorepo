import { createHookWriter } from '@hyperlane-xyz/deploy-sdk';
import {
  EvmHookModule,
  type HookConfig,
  HookConfigSchema,
  type TypedAnnotatedTransaction,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
  isHookCompatible,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, isEVMLike, mustGet } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { validateHookConfigForAltVM } from '../deploy/configValidation.js';
import { getSubmitterByStrategy } from '../deploy/warp.js';
import { logCommandHeader, logGray, logGreen } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

interface HookApplyParams {
  context: WriteCommandContext;
  chain: string;
  address: Address;
  configPath: string;
  strategyUrl?: string;
}

/**
 * Applies a hook configuration to an existing on-chain hook, generating
 * and submitting the minimal set of update transactions (or redeploying
 * if the type / immutable fields changed).
 */
export async function runHookApply({
  context,
  chain,
  address,
  configPath,
  strategyUrl,
}: HookApplyParams): Promise<void> {
  logCommandHeader('Hyperlane Hook Apply');

  const { multiProvider, registry } = context;

  // Read and validate hook config
  const rawConfig = await readYamlOrJson(configPath);
  const parseResult = HookConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    throw new Error(
      `Invalid hook config: ${firstIssue.path.join('.')} => ${firstIssue.message}`,
    );
  }
  const hookConfig: HookConfig = parseResult.data;

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

  const protocol = multiProvider.getProtocol(chain);
  const transactions: TypedAnnotatedTransaction[] = isEVMLike(protocol)
    ? await generateEvmHookUpdateTxs({
        context,
        chain,
        address,
        hookConfig,
        chainAddresses,
      })
    : await generateNonEvmHookUpdateTxs({
        context,
        chain,
        address,
        hookConfig,
        chainAddresses,
      });

  if (transactions.length === 0) {
    logGreen(
      `Hook config on ${chain} is the same as target. No updates needed.`,
    );
    return;
  }

  const { submitter } = await getSubmitterByStrategy({
    chain,
    context,
    strategyUrl,
  });

  logGray(`Submitting ${transactions.length} hook update transactions...`);
  // CAST: the TxSubmitterBuilder.submit signature is overly narrow for the
  // unified TypedAnnotatedTransaction shape; warp apply does the same cast.
  await submitter.submit(...(transactions as any[]));
  logGreen(`Hook config updated on ${chain}.`);
}

async function generateEvmHookUpdateTxs({
  context,
  chain,
  address,
  hookConfig,
  chainAddresses,
}: {
  context: WriteCommandContext;
  chain: string;
  address: Address;
  hookConfig: Exclude<HookConfig, string>;
  chainAddresses: Record<string, string>;
}): Promise<TypedAnnotatedTransaction[]> {
  const { multiProvider } = context;

  assert(
    chainAddresses.proxyAdmin,
    `No proxyAdmin address found for chain ${chain}`,
  );

  const proxyFactoryFactories =
    extractIsmAndHookFactoryAddresses(chainAddresses);

  const evmHookModule = new EvmHookModule(multiProvider, {
    addresses: {
      ...proxyFactoryFactories,
      mailbox: chainAddresses.mailbox,
      proxyAdmin: chainAddresses.proxyAdmin,
      deployedHook: address,
    },
    chain,
    config: hookConfig,
  });

  return evmHookModule.update(hookConfig);
}

async function generateNonEvmHookUpdateTxs({
  context,
  chain,
  address,
  hookConfig,
  chainAddresses,
}: {
  context: WriteCommandContext;
  chain: string;
  address: Address;
  hookConfig: Exclude<HookConfig, string>;
  chainAddresses: Record<string, string>;
}): Promise<TypedAnnotatedTransaction[]> {
  const { multiProvider, altVmSigners } = context;

  const signer = mustGet(altVmSigners, chain);
  const chainLookup = altVmChainLookup(multiProvider);
  const chainMetadata = chainLookup.getChainMetadata(chain);

  const writer = createHookWriter(chainMetadata, chainLookup, signer, {
    mailbox: chainAddresses.mailbox,
  });

  // deployOrUpdate handles both 'update existing' and 'redeploy when type
  // or immutable fields changed' — callers express intent declaratively
  // rather than picking between writer.create() and .update() themselves.
  const { transactions } = await writer.deployOrUpdate({
    actualAddress: address,
    expectedConfig: validateHookConfigForAltVM(hookConfig, chain),
  });

  return transactions;
}
