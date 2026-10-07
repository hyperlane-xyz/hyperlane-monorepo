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

export interface ExportStore {
  read(chain: ChainName): Promise<ChainExport | undefined>;
  update(
    chain: ChainName,
    update: ChainExportUpdate,
    now: string,
  ): Promise<void>;
}

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

export function createMemoryExportStore(
  initial: ChainMap<ChainExport> = {},
): ExportStore & { snapshot(): ChainMap<ChainExport> } {
  const entries = new Map<ChainName, ChainExport>(Object.entries(initial));
  return {
    async read(chain) {
      return entries.get(chain);
    },
    async update(chain, update, now) {
      const { entry } = mergeChainExport(entries.get(chain), update, now);
      entries.set(chain, entry);
    },
    snapshot() {
      return Object.fromEntries(
        [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
    },
  };
}

export function createFileExportStore(filepath: string): ExportStore {
  let queue: Promise<void> = Promise.resolve();

  const readAll = (): ChainMap<ChainExport> =>
    pathExists(filepath) ? readJson<ChainMap<ChainExport>>(filepath) : {};

  return {
    async read(chain) {
      await queue;
      return readAll()[chain];
    },
    update(chain, update, now) {
      const run = queue.then(async () => {
        const all = readAll();
        const { entry, changed } = mergeChainExport(all[chain], update, now);
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
