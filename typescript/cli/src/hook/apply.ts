import { createHookWriter } from '@hyperlane-xyz/deploy-sdk';
import {
  EvmHookModule,
  type HookConfig,
  type TypedAnnotatedTransaction,
  altVmChainLookup,
  extractIsmAndHookFactoryAddresses,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  assert,
  eqAddress,
  isEVMLike,
  mustGet,
} from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { validateHookConfigForAltVM } from '../deploy/configValidation.js';
import { getSubmitterByStrategy } from '../deploy/warp.js';
import { logCommandHeader, logGray, logGreen } from '../logger.js';

import { validateAndParseHookConfig } from './config.js';

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

  const { hookConfig, chainAddresses } = await validateAndParseHookConfig({
    configPath,
    chain,
    multiProvider,
    registry,
  });

  const protocol = multiProvider.getProtocol(chain);
  const { address: resultAddress, transactions } = isEVMLike(protocol)
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

  const redeployed = !eqAddress(resultAddress, address);
  if (redeployed) {
    logGreen(
      `Hook on ${chain} was redeployed to ${resultAddress} (type or immutable field changed). The original hook at ${address} is no longer referenced — update any callers.`,
    );
  }

  if (transactions.length === 0) {
    if (!redeployed) {
      logGreen(
        `Hook config on ${chain} is the same as target. No updates needed.`,
      );
    }
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
}): Promise<{ address: Address; transactions: TypedAnnotatedTransaction[] }> {
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

  const transactions = await evmHookModule.update(hookConfig);
  return {
    address: evmHookModule.serialize().deployedHook,
    transactions,
  };
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
}): Promise<{ address: Address; transactions: TypedAnnotatedTransaction[] }> {
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
  return writer.deployOrUpdate({
    actualAddress: address,
    expectedConfig: validateHookConfigForAltVM(hookConfig, chain),
  });
}
