#!/usr/bin/env tsx
/**
 * Generate shovel config for Hyperlane local database-native pipeline.
 *
 * Usage:
 *   DEPLOY_ENV=testnet4 INDEXED_CHAINS=sepolia pnpm shovel:config
 *   pnpm shovel:config --chain sepolia --out local/shovel/shovel.local.json
 */
import fs from 'fs';
import path from 'path';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { assert } from '@hyperlane-xyz/utils';

import { InterchainGasPaymasterAbi } from '../abis/InterchainGasPaymaster.js';
import { MailboxAbi } from '../abis/Mailbox.js';
import { MerkleTreeHookAbi } from '../abis/MerkleTreeHook.js';
import { type DeployEnv, loadChainConfigs } from '../src/config/chains.js';
import {
  type ContractAddresses,
  loadContractAddresses,
} from '../src/config/contracts.js';

type ShovelColumnType = 'bool' | 'byte' | 'bytea' | 'int' | 'numeric' | 'text';

interface ShovelTableColumn {
  name: string;
  type: ShovelColumnType;
}

interface ShovelTable {
  name: string;
  columns: ShovelTableColumn[];
}

interface ShovelBlockBinding {
  name: string;
  column: string;
  filter_op?: 'contains' | 'eq';
  filter_arg?: string[];
}

interface ShovelEventInput {
  name: string;
  type: string;
  indexed: boolean;
  column?: string;
}

interface ShovelEvent {
  name: string;
  type: 'event';
  anonymous: boolean;
  inputs: ShovelEventInput[];
}

interface ShovelIntegration {
  name: string;
  enabled: true;
  sources: Array<{ name: string; start: number }>;
  table: ShovelTable;
  block: ShovelBlockBinding[];
  event: ShovelEvent;
}

interface ShovelEthSource {
  name: string;
  chain_id: number;
  urls: string[];
  ws_url?: string;
  batch_size: number;
  concurrency: number;
  poll_duration: string;
}

interface ShovelConfig {
  pg_url: string;
  eth_sources: ShovelEthSource[];
  integrations: ShovelIntegration[];
}

interface ParsedArgs {
  out: string;
  chain: string | undefined;
  startBlock: number | undefined;
  batchSize: number;
  concurrency: number;
  pollDuration: string;
}

type AbiEvent = {
  type: 'event';
  name: string;
  anonymous?: boolean;
  inputs: readonly {
    name: string;
    type: string;
    indexed?: boolean;
  }[];
};

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let out = 'local/shovel/shovel.local.json';
  let chain: string | undefined;
  let startBlock: number | undefined;
  let batchSize = 25;
  let concurrency = 1;
  let pollDuration = '1s';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--out' && next) {
      out = next;
      i += 1;
    } else if (arg === '--chain' && next) {
      chain = next.toLowerCase();
      i += 1;
    } else if (arg === '--start-block' && next) {
      startBlock = Number(next);
      i += 1;
    } else if (arg === '--batch-size' && next) {
      batchSize = Number(next);
      i += 1;
    } else if (arg === '--concurrency' && next) {
      concurrency = Number(next);
      i += 1;
    } else if (arg === '--poll-duration' && next) {
      pollDuration = next;
      i += 1;
    }
  }

  assert(Number.isFinite(batchSize) && batchSize > 0, 'Invalid --batch-size');
  assert(
    Number.isFinite(concurrency) && concurrency > 0,
    'Invalid --concurrency',
  );
  if (startBlock !== undefined) {
    assert(
      Number.isFinite(startBlock) && startBlock >= 0,
      'Invalid --start-block',
    );
  }

  return {
    out,
    chain,
    startBlock,
    batchSize,
    concurrency,
    pollDuration,
  };
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function getRpcUrls(
  chainName: string,
  fallback: string,
  registryUrls: string[],
): string[] {
  const envName = chainName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const explicitMany = process.env[`HYP_RPCS_${envName}`];
  if (explicitMany) {
    const parsed = explicitMany
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  const explicitSingle = process.env[`HYP_RPC_${envName}`];
  if (explicitSingle) {
    return [explicitSingle];
  }

  const chainRpcUrls = process.env.CHAIN_RPC_URLS;
  if (chainRpcUrls) {
    try {
      const parsed = JSON.parse(chainRpcUrls) as Record<
        string,
        string | string[]
      >;
      const value = parsed[chainName];
      if (typeof value === 'string' && value.trim().length > 0) {
        return [value.trim()];
      }
      if (Array.isArray(value)) {
        const urls = value
          .map((v) => (typeof v === 'string' ? v.trim() : ''))
          .filter(Boolean);
        if (urls.length > 0) {
          return urls;
        }
      }
    } catch {
      // ignore invalid JSON; config/chains already logs parse failures
    }
  }

  if (registryUrls.length > 0) {
    return registryUrls;
  }

  return [fallback];
}

function getWsUrl(chainName: string): string | undefined {
  const envName = chainName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return process.env[`HYP_WS_${envName}`];
}

async function loadRegistryRpcUrls(
  chainNames: string[],
): Promise<Record<string, string[]>> {
  const { getRegistry } = await import('@hyperlane-xyz/registry/fs');

  const registryUri = process.env.REGISTRY_URI || DEFAULT_GITHUB_REGISTRY;
  const registry = getRegistry({
    registryUris: [registryUri],
    enableProxy: true,
  });

  const metadata = await registry.getMetadata();
  const result: Record<string, string[]> = {};

  for (const chainName of chainNames) {
    const chain = metadata[chainName];
    const rpcEntries: Array<{ http?: string }> = Array.isArray(chain?.rpcUrls)
      ? (chain.rpcUrls as Array<{ http?: string }>)
      : [];
    const urls = rpcEntries
      .map((rpc) => rpc.http?.trim())
      .filter((u): u is string => Boolean(u));
    result[chainName] = urls;
  }

  return result;
}

function getEvent(
  abi: readonly AbiEvent[],
  eventName: string,
  columnMap: Record<string, string>,
): ShovelEvent {
  const event = abi.find(
    (item) => item.type === 'event' && item.name === eventName,
  );
  assert(event, `Missing ABI event ${eventName}`);

  return {
    name: eventName,
    type: 'event',
    anonymous: Boolean(event.anonymous),
    inputs: event.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      indexed: Boolean(input.indexed),
      column: columnMap[input.name],
    })),
  };
}

function commonTableColumns(): ShovelTableColumn[] {
  return [
    { name: 'chain_id', type: 'int' },
    { name: 'block_hash', type: 'bytea' },
    { name: 'block_time', type: 'numeric' },
    { name: 'tx_hash', type: 'bytea' },
    { name: 'tx_signer', type: 'bytea' },
    { name: 'tx_to', type: 'bytea' },
    { name: 'tx_nonce', type: 'numeric' },
    { name: 'tx_input', type: 'bytea' },
    { name: 'tx_gas_price', type: 'numeric' },
    { name: 'tx_max_priority_fee_per_gas', type: 'numeric' },
    { name: 'tx_max_fee_per_gas', type: 'numeric' },
    { name: 'tx_gas_used', type: 'numeric' },
    { name: 'tx_effective_gas_price', type: 'numeric' },
  ];
}

function commonBlockBindings(
  contractColumn: string,
  contractAddress: `0x${string}`,
): ShovelBlockBinding[] {
  return [
    { name: 'chain_id', column: 'chain_id' },
    { name: 'block_hash', column: 'block_hash' },
    { name: 'block_time', column: 'block_time' },
    { name: 'tx_hash', column: 'tx_hash' },
    { name: 'tx_idx', column: 'tx_idx' },
    { name: 'tx_signer', column: 'tx_signer' },
    { name: 'tx_to', column: 'tx_to' },
    { name: 'tx_nonce', column: 'tx_nonce' },
    { name: 'tx_input', column: 'tx_input' },
    { name: 'tx_gas_price', column: 'tx_gas_price' },
    {
      name: 'tx_max_priority_fee_per_gas',
      column: 'tx_max_priority_fee_per_gas',
    },
    { name: 'tx_max_fee_per_gas', column: 'tx_max_fee_per_gas' },
    { name: 'tx_gas_used', column: 'tx_gas_used' },
    { name: 'tx_effective_gas_price', column: 'tx_effective_gas_price' },
    {
      name: 'log_addr',
      column: contractColumn,
      filter_op: 'contains',
      filter_arg: [stripHexPrefix(contractAddress.toLowerCase())],
    },
  ];
}

function mailboxIntegrations(
  chainName: string,
  startBlock: number,
  addresses: ContractAddresses,
): ShovelIntegration[] {
  const sources = [{ name: chainName, start: startBlock }];
  const mailbox = addresses.mailbox;

  return [
    {
      name: `${chainName}_mailbox_dispatch`,
      enabled: true,
      sources,
      table: {
        name: 'hl_mailbox_dispatch',
        columns: [
          ...commonTableColumns(),
          { name: 'mailbox', type: 'bytea' },
          { name: 'message', type: 'bytea' },
        ],
      },
      block: commonBlockBindings('mailbox', mailbox),
      event: getEvent(MailboxAbi as readonly AbiEvent[], 'Dispatch', {
        message: 'message',
      }),
    },
    {
      name: `${chainName}_mailbox_dispatch_id`,
      enabled: true,
      sources,
      table: {
        name: 'hl_mailbox_dispatch_id',
        columns: [
          ...commonTableColumns(),
          { name: 'mailbox', type: 'bytea' },
          { name: 'message_id', type: 'bytea' },
        ],
      },
      block: commonBlockBindings('mailbox', mailbox),
      event: getEvent(MailboxAbi as readonly AbiEvent[], 'DispatchId', {
        messageId: 'message_id',
      }),
    },
    {
      name: `${chainName}_mailbox_process_id`,
      enabled: true,
      sources,
      table: {
        name: 'hl_mailbox_process_id',
        columns: [
          ...commonTableColumns(),
          { name: 'mailbox', type: 'bytea' },
          { name: 'message_id', type: 'bytea' },
        ],
      },
      block: commonBlockBindings('mailbox', mailbox),
      event: getEvent(MailboxAbi as readonly AbiEvent[], 'ProcessId', {
        messageId: 'message_id',
      }),
    },
  ];
}

function igpIntegration(
  chainName: string,
  startBlock: number,
  igpAddress: `0x${string}`,
): ShovelIntegration {
  return {
    name: `${chainName}_igp_gas_payment`,
    enabled: true,
    sources: [{ name: chainName, start: startBlock }],
    table: {
      name: 'hl_igp_gas_payment',
      columns: [
        ...commonTableColumns(),
        { name: 'interchain_gas_paymaster', type: 'bytea' },
        { name: 'message_id', type: 'bytea' },
        { name: 'destination_domain', type: 'numeric' },
        { name: 'gas_amount', type: 'numeric' },
        { name: 'payment', type: 'numeric' },
      ],
    },
    block: commonBlockBindings('interchain_gas_paymaster', igpAddress),
    event: getEvent(
      InterchainGasPaymasterAbi as readonly AbiEvent[],
      'GasPayment',
      {
        messageId: 'message_id',
        destinationDomain: 'destination_domain',
        gasAmount: 'gas_amount',
        payment: 'payment',
      },
    ),
  };
}

function merkleIntegration(
  chainName: string,
  startBlock: number,
  merkleAddress: `0x${string}`,
): ShovelIntegration {
  return {
    name: `${chainName}_merkle_insert`,
    enabled: true,
    sources: [{ name: chainName, start: startBlock }],
    table: {
      name: 'hl_merkle_insert',
      columns: [
        ...commonTableColumns(),
        { name: 'merkle_tree_hook', type: 'bytea' },
        { name: 'message_id', type: 'bytea' },
        { name: 'leaf_index', type: 'numeric' },
      ],
    },
    block: commonBlockBindings('merkle_tree_hook', merkleAddress),
    event: getEvent(
      MerkleTreeHookAbi as readonly AbiEvent[],
      'InsertedIntoTree',
      {
        messageId: 'message_id',
        index: 'leaf_index',
      },
    ),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.chain) {
    process.env.INDEXED_CHAINS = args.chain;
  }

  const deployEnv = (process.env.DEPLOY_ENV || 'testnet4') as DeployEnv;
  const chains = await loadChainConfigs(deployEnv);
  assert(chains.length > 0, 'No chains resolved for shovel config generation');

  const addressesByChain = await loadContractAddresses(chains);
  const registryRpcUrlsByChain = await loadRegistryRpcUrls(
    chains.map((chain) => chain.name),
  );

  const ethSources: ShovelEthSource[] = [];
  const integrations: ShovelIntegration[] = [];

  for (const chain of chains) {
    const addresses = addressesByChain[chain.name];
    if (!addresses?.mailbox) {
      continue;
    }

    const startBlock = args.startBlock ?? chain.startBlock ?? 0;
    const rpcUrls = getRpcUrls(
      chain.name,
      chain.rpcUrl,
      registryRpcUrlsByChain[chain.name] || [],
    );
    const wsUrl = getWsUrl(chain.name);

    ethSources.push({
      name: chain.name,
      chain_id: chain.chainId,
      urls: rpcUrls,
      ws_url: wsUrl,
      batch_size: args.batchSize,
      concurrency: args.concurrency,
      poll_duration: args.pollDuration,
    });

    integrations.push(
      ...mailboxIntegrations(chain.name, startBlock, addresses),
    );

    if (addresses.interchainGasPaymaster) {
      integrations.push(
        igpIntegration(
          chain.name,
          startBlock,
          addresses.interchainGasPaymaster,
        ),
      );
    }

    if (addresses.merkleTreeHook) {
      integrations.push(
        merkleIntegration(chain.name, startBlock, addresses.merkleTreeHook),
      );
    }
  }

  assert(
    ethSources.length > 0,
    'No chain sources with mailbox addresses found',
  );
  assert(integrations.length > 0, 'No integrations generated');

  const config: ShovelConfig = {
    pg_url: '$DATABASE_URL',
    eth_sources: ethSources,
    integrations,
  };

  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Wrote shovel config: ${outPath}`);
  console.log(`Sources: ${ethSources.length}`);
  console.log(`Integrations: ${integrations.length}`);
}

main().catch((error) => {
  const err = error as Error;
  console.error('Failed to generate shovel config:', err.message);
  process.exit(1);
});
