import type { Domain } from '@hyperlane-xyz/utils';

import type { TrackedActionBase } from '../types.js';

/**
 * Generic store interface for tracking entities.
 * Provides CRUD operations and query methods for any tracked entity type.
 *
 * @template T - The entity type extending TrackedActionBase
 * @template Status - The status enum type for this entity
 */
export interface IStore<T extends TrackedActionBase, Status extends string> {
  /**
   * Save a new entity or update an existing one.
   */
  save(entity: T): Promise<void>;

  /**
   * Retrieve an entity by ID.
   */
  get(id: string): Promise<T | undefined>;

  /**
   * Retrieve all entities.
   */
  getAll(): Promise<T[]>;

  /**
   * Update an entity with partial data.
   * Automatically updates the `updatedAt` timestamp.
   */
  update(id: string, updates: Partial<T>): Promise<void>;

  /**
   * Delete an entity by ID.
   */
  delete(id: string): Promise<void>;

  /**
   * Query entities by status.
   */
  getByStatus(status: Status): Promise<T[]>;

  /**
   * Query entities by destination domain.
   */
  getByDestination(destination: Domain): Promise<T[]>;
}
