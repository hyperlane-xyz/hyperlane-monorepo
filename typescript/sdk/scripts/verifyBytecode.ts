#!/usr/bin/env tsx
/* eslint-disable no-console -- standalone CLI harness; console is the intended output channel */
import fs from 'fs';

import { providers } from 'ethers';

import { assert } from '@hyperlane-xyz/utils';

import {
  BytecodeComparison,
  BytecodeValidity,
  compareBytecode,
} from '../src/deploy/verify/bytecodeComparator.js';
import {
  type BytecodeManifestSet,
  generateManifestFromBuildInfoDir,
} from '../src/deploy/verify/bytecodeManifest.js';
import { MultiProvider } from '../src/providers/MultiProvider.js';
import {
  checkWarpRouteBytecode,
  type WarpBytecodeComparison,
} from '../src/token/warpBytecodeCheck.js';
import type { ChainMap } from '../src/types.js';
import type { WarpCoreConfig } from '../src/warp/types.js';

interface Args {
  buildInfo: string[];
  version: string[];
  manifest?: string;
  out?: string;
  address?: string;
  chain?: string;
  expect?: string;
  rpc?: string;
  warp?: string;
}

interface RegistryModule {
  DEFAULT_GITHUB_REGISTRY: string;
  chainMetadata: ChainMap<
    ConstructorParameters<typeof MultiProvider>[0][string]
  >;
}

interface FsRegistryModule {
  getRegistry(params: { registryUris: string[]; enableProxy: boolean }): {
    getWarpRoute(id: string): Promise<WarpCoreConfig | null>;
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = { buildInfo: [], version: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg.startsWith('--')) continue;
    assert(next, `Missing value for ${arg}`);
    i += 1;
    switch (arg) {
      case '--build-info':
        args.buildInfo.push(next);
        break;
      case '--version':
        args.version.push(next);
        break;
      case '--manifest':
        args.manifest = next;
        break;
      case '--out':
        args.out = next;
        break;
      case '--address':
        args.address = next;
        break;
      case '--chain':
        args.chain = next;
        break;
      case '--expect':
        args.expect = next;
        break;
      case '--rpc':
        args.rpc = next;
        break;
      case '--warp':
        args.warp = next;
        break;
      default:
        throw new Error(`Unknown arg ${arg}`);
    }
  }
  return args;
}

function loadManifestSet(args: Args): BytecodeManifestSet {
  if (args.manifest) {
    return JSON.parse(
      fs.readFileSync(args.manifest, 'utf8'),
    ) as BytecodeManifestSet;
  }

  assert(
    args.buildInfo.length > 0,
    'Must pass --manifest or --build-info/--version',
  );
  assert(
    args.buildInfo.length === args.version.length,
    '--build-info and --version counts must match',
  );

  const manifestSet: BytecodeManifestSet = {};
  for (let i = 0; i < args.buildInfo.length; i++) {
    const buildInfoDir = args.buildInfo[i];
    const version = args.version[i];
    assert(buildInfoDir, `Missing --build-info at index ${i}`);
    assert(version, `Missing --version at index ${i}`);
    manifestSet[version] = generateManifestFromBuildInfoDir(
      buildInfoDir,
      version,
    );
  }

  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(manifestSet, null, 2)}\n`);
  }
  return manifestSet;
}

async function makeMultiProvider(
  chain: string | undefined,
  rpc: string | undefined,
): Promise<MultiProvider> {
  const registryModule =
    (await import('@hyperlane-xyz/registry')) as RegistryModule;
  const multiProvider = new MultiProvider(registryModule.chainMetadata);
  if (chain && rpc) {
    multiProvider.setProvider(chain, new providers.JsonRpcProvider(rpc));
  }
  return multiProvider;
}

async function loadWarpCoreConfig(
  warpRouteId: string,
): Promise<WarpCoreConfig> {
  const registryModule =
    (await import('@hyperlane-xyz/registry')) as RegistryModule;
  const fsRegistryModule =
    (await import('@hyperlane-xyz/registry/fs')) as FsRegistryModule;
  const registryUri =
    process.env.REGISTRY_URI ?? registryModule.DEFAULT_GITHUB_REGISTRY;
  const registry = fsRegistryModule.getRegistry({
    registryUris: [registryUri],
    enableProxy: true,
  });
  const warpCoreConfig = await registry.getWarpRoute(warpRouteId);
  assert(warpCoreConfig, `Warp route not found: ${warpRouteId}`);
  return warpCoreConfig;
}

function shortHash(hash: string | undefined): string {
  if (!hash) return '';
  return hash.length > 18 ? `${hash.slice(0, 10)}..${hash.slice(-8)}` : hash;
}

function printComparisons(
  comparisons: Array<BytecodeComparison | WarpBytecodeComparison>,
): void {
  const rows = comparisons.map((comparison) => ({
    chain: 'chain' in comparison ? comparison.chain : '',
    address: comparison.address,
    impl: comparison.implementationAddress,
    version: comparison.onchainVersion ?? '',
    validity: comparison.validity,
    contract:
      comparison.matchedContractName ?? comparison.expectedContractName ?? '',
    onchainHash: shortHash(comparison.onchainMaskedHash),
    expectedHash: shortHash(comparison.expectedHash),
    note: comparison.note ?? '',
  }));
  console.table(rows);

  const advisories = comparisons.filter(
    (comparison) =>
      comparison.validity === BytecodeValidity.VersionUnavailable ||
      comparison.validity === BytecodeValidity.NoCode,
  );
  if (advisories.length > 0) {
    console.error(`Advisory results: ${advisories.length}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestSet = loadManifestSet(args);

  if (args.address) {
    assert(
      args.chain || args.rpc,
      'Single-address mode needs --chain or --rpc',
    );
    const provider = args.rpc
      ? new providers.JsonRpcProvider(args.rpc)
      : (await makeMultiProvider(args.chain, undefined)).getProvider(
          args.chain,
        );
    const comparison = await compareBytecode(
      provider,
      args.address,
      manifestSet,
      {
        expectedContractName: args.expect,
      },
    );
    printComparisons([
      args.chain ? { ...comparison, chain: args.chain } : comparison,
    ]);
    return;
  }

  if (args.warp) {
    const multiProvider = await makeMultiProvider(args.chain, args.rpc);
    const warpCoreConfig = await loadWarpCoreConfig(args.warp);
    const comparisons = await checkWarpRouteBytecode(
      multiProvider,
      warpCoreConfig,
      manifestSet,
      { warpRouteId: args.warp },
    );
    printComparisons(comparisons);
    return;
  }

  if (args.out) {
    console.log(`Wrote manifest set to ${args.out}`);
    return;
  }

  throw new Error('No action requested. Use --address or --warp.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
