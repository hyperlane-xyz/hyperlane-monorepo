import type { Domain } from '@hyperlane-xyz/utils';

import type { TrackedActionBase } from '../types.js';

import type { IStore } from './IStore.js';

/**
 * In-memory implementation of the IStore interface.
 * Uses a Map for fast lookups and keeps all data in memory.
 *
 * @template T - The entity type extending TrackedActionBase
 * @template Status - The status enum type for this entity
 */
export class InMemoryStore<T extends TrackedActionBase, Status extends string>
  implements IStore<T, Status>
{
  protected data: Map<string, T> = new Map();

  async save(entity: T): Promise<void> {
    this.data.set(entity.id, entity);
  }

  async get(id: string): Promise<T | undefined> {
    return this.data.get(id);
  }

  async getAll(): Promise<T[]> {
    return Array.from(this.data.values());
  }

  async update(id: string, updates: Partial<T>): Promise<void> {
    const existing = this.data.get(id);
    if (!existing) {
      throw new Error(`Entity ${id} not found`);
    }
    this.data.set(id, {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    } as T);
  }

  async delete(id: string): Promise<void> {
    this.data.delete(id);
  }

  async getByStatus(status: Status): Promise<T[]> {
    return Array.from(this.data.values()).filter(
      (entity) => entity.status === status,
    );
  }

  async getByDestination(destination: Domain): Promise<T[]> {
    return Array.from(this.data.values()).filter(
      (entity) => entity.destination === destination,
    );
  }
}
