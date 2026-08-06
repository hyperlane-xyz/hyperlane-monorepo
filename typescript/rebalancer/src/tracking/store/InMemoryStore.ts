import type { Domain } from '@hyperlane-xyz/utils';

import type { TrackedActionBase } from '../types.js';

import type { IStore } from './IStore.js';

/**
 * In-memory implementation of the IStore interface.
 * Uses a Map for fast lookups and keeps all data in memory.
 * Returned entities are live references; mutate stored entities only through
 * save/update/delete so indexes stay consistent.
 *
 * @template T - The entity type extending TrackedActionBase
 * @template Status - The status enum type for this entity
 */
export class InMemoryStore<
  T extends TrackedActionBase,
  Status extends string,
> implements IStore<T, Status> {
  protected data: Map<string, T> = new Map();
  private readonly indexes = new Map<keyof T, Map<unknown, Set<string>>>();

  async save(entity: T): Promise<void> {
    const existing = this.data.get(entity.id);
    if (existing) {
      this.removeFromIndexes(existing);
    }

    this.data.set(entity.id, entity);
    this.addToIndexes(entity);
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

    const updated = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    } as T;

    this.removeFromIndexes(existing);
    this.data.set(id, updated);
    this.addToIndexes(updated);
  }

  async delete(id: string): Promise<void> {
    const existing = this.data.get(id);
    if (existing) {
      this.removeFromIndexes(existing);
      this.data.delete(id);
    }
  }

  async getByStatus(status: Status): Promise<T[]> {
    return this.getByField('status', status);
  }

  async getByDestination(destination: Domain): Promise<T[]> {
    return this.getByField('destination', destination);
  }

  async getByField<K extends keyof T>(field: K, value: T[K]): Promise<T[]> {
    const index = this.getIndex(field);
    return this.getEntities(index.get(value));
  }

  /**
   * Index-backed queries return index bucket order, not global insertion order.
   * Updating an entity can move it to the end of its indexed value bucket.
   */
  async getByFieldValues<K extends keyof T>(
    field: K,
    values: readonly T[K][],
  ): Promise<T[]> {
    const index = this.getIndex(field);
    const ids = new Set<string>();

    for (const value of values) {
      for (const id of index.get(value) ?? []) {
        ids.add(id);
      }
    }

    return this.getEntities(ids);
  }

  async getOneByField<K extends keyof T>(
    field: K,
    value: T[K],
  ): Promise<T | undefined> {
    const matches = await this.getByField(field, value);
    return matches[0];
  }

  private getIndex<K extends keyof T>(field: K): Map<unknown, Set<string>> {
    let index = this.indexes.get(field);
    if (!index) {
      index = new Map<unknown, Set<string>>();
      for (const entity of this.data.values()) {
        this.addToIndex(index, entity[field], entity.id);
      }
      this.indexes.set(field, index);
    }

    return index;
  }

  private addToIndexes(entity: T): void {
    for (const [field, index] of this.indexes) {
      this.addToIndex(index, entity[field], entity.id);
    }
  }

  private removeFromIndexes(entity: T): void {
    for (const [field, index] of this.indexes) {
      const ids = index.get(entity[field]);
      if (!ids) {
        continue;
      }

      ids.delete(entity.id);
      if (ids.size === 0) {
        index.delete(entity[field]);
      }
    }
  }

  private addToIndex(
    index: Map<unknown, Set<string>>,
    value: unknown,
    id: string,
  ): void {
    const ids = index.get(value) ?? new Set<string>();
    ids.add(id);
    index.set(value, ids);
  }

  private getEntities(ids: Set<string> | undefined): T[] {
    if (!ids) {
      return [];
    }

    const entities: T[] = [];
    for (const id of ids) {
      const entity = this.data.get(id);
      if (entity) {
        entities.push(entity);
      }
    }

    return entities;
  }
}
