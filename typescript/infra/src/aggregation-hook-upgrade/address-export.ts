import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { Address, deepEquals, eqAddress } from '@hyperlane-xyz/utils';
import { pathExists, readJson } from '@hyperlane-xyz/utils/fs';

import { writeAndFormatJsonAtPath } from '../utils/utils.js';

import type { UpgradePhase } from './types.js';

export interface ExportedFactory {
  address: Address;
  version: string;
}

export interface ExportedAggregator {
  children: Address[];
  address: Address;
  replaces: Address[];
}

export interface ChainExport {
  signer: Address;
  phase: UpgradePhase;
  routingHook: Address;
  routingHookOwner: Address;
  routingHookOwnerType: string;
  factory: ExportedFactory & { previous?: ExportedFactory };
  aggregators: ExportedAggregator[];
  shadowRoutingHook?: Address;
  firstRecordedAt: string;
  updatedAt: string;
}

export type ChainExportUpdate = Omit<
  ChainExport,
  'firstRecordedAt' | 'updatedAt'
>;

export type ExportStore = ChainStore<ChainExport, ChainExportUpdate>;

function mergeAggregators(
  existing: ExportedAggregator[],
  incoming: ExportedAggregator[],
): ExportedAggregator[] {
  const byAddress = new Map<string, ExportedAggregator>();
  for (const aggregator of [...existing, ...incoming]) {
    const key = aggregator.address.toLowerCase();
    const previous = byAddress.get(key);
    const replaces = [...(previous?.replaces ?? [])];
    for (const old of aggregator.replaces) {
      if (!replaces.some((known) => eqAddress(known, old))) replaces.push(old);
    }
    byAddress.set(key, {
      children: aggregator.children,
      address: aggregator.address,
      replaces,
    });
  }
  return [...byAddress.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, aggregator]) => aggregator);
}

function mergeFactory(
  existing: ChainExport['factory'] | undefined,
  incoming: ChainExportUpdate['factory'],
): ChainExport['factory'] {
  const rotatedFrom: ExportedFactory | undefined =
    existing && !eqAddress(existing.address, incoming.address)
      ? { address: existing.address, version: existing.version }
      : undefined;
  const previous = incoming.previous ?? rotatedFrom ?? existing?.previous;
  const merged: ChainExport['factory'] = {
    address: incoming.address,
    version: incoming.version,
  };
  if (previous) merged.previous = previous;
  return merged;
}

export function mergeChainExport(
  existing: ChainExport | undefined,
  update: ChainExportUpdate,
  now: string,
): { entry: ChainExport; changed: boolean } {
  const shadowRoutingHook =
    update.shadowRoutingHook ?? existing?.shadowRoutingHook;
  const candidate: ChainExport = {
    signer: update.signer,
    phase: update.phase,
    routingHook: update.routingHook,
    routingHookOwner: update.routingHookOwner,
    routingHookOwnerType: update.routingHookOwnerType,
    factory: mergeFactory(existing?.factory, update.factory),
    aggregators: mergeAggregators(
      existing?.aggregators ?? [],
      update.aggregators,
    ),
    firstRecordedAt: existing?.firstRecordedAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
  if (shadowRoutingHook !== undefined) {
    candidate.shadowRoutingHook = shadowRoutingHook;
  }
  const changed = existing === undefined || !deepEquals(existing, candidate);
  if (changed) candidate.updatedAt = now;
  return { entry: candidate, changed };
}

export interface ChainStore<Entry, Update> {
  read(chain: ChainName): Promise<Entry | undefined>;
  update(chain: ChainName, update: Update, now: string): Promise<void>;
}

export type MergeChainEntry<Entry, Update> = (
  existing: Entry | undefined,
  update: Update,
  now: string,
) => { entry: Entry; changed: boolean };

export function createMemoryChainStore<Entry, Update>(
  merge: MergeChainEntry<Entry, Update>,
  initial: ChainMap<Entry> = {},
): ChainStore<Entry, Update> & { snapshot(): ChainMap<Entry> } {
  const entries = new Map<ChainName, Entry>(Object.entries(initial));
  return {
    async read(chain) {
      return entries.get(chain);
    },
    async update(chain, update, now) {
      const { entry } = merge(entries.get(chain), update, now);
      entries.set(chain, entry);
    },
    snapshot() {
      return Object.fromEntries(
        [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
    },
  };
}

// Updates are serialized because the formatter rewrites the file after each
// write, so concurrent chains must not interleave their read-merge-write cycles.
export function createFileChainStore<Entry, Update>(
  filepath: string,
  merge: MergeChainEntry<Entry, Update>,
): ChainStore<Entry, Update> {
  let queue: Promise<void> = Promise.resolve();

  const readAll = (): ChainMap<Entry> =>
    pathExists(filepath) ? readJson<ChainMap<Entry>>(filepath) : {};

  return {
    async read(chain) {
      await queue;
      return readAll()[chain];
    },
    update(chain, update, now) {
      const run = queue.then(async () => {
        const all = readAll();
        const { entry, changed } = merge(all[chain], update, now);
        if (!changed) return;
        all[chain] = entry;
        const sorted = Object.fromEntries(
          Object.entries(all).sort(([a], [b]) => a.localeCompare(b)),
        );
        await writeAndFormatJsonAtPath(filepath, sorted);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

export function createMemoryExportStore(
  initial: ChainMap<ChainExport> = {},
): ExportStore & { snapshot(): ChainMap<ChainExport> } {
  return createMemoryChainStore(mergeChainExport, initial);
}

export function createFileExportStore(filepath: string): ExportStore {
  return createFileChainStore(filepath, mergeChainExport);
}
