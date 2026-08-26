import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Domain } from '@hyperlane-xyz/utils';

import type { TrackedActionBase } from '../types.js';

import type { IStore } from './IStore.js';

const STORE_VERSION = 1;
const BIGINT_MARKER = '__hyperlane_bigint__';

type EntityValidator<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { [BIGINT_MARKER]: value.toString() };
  }
  return value;
}

function parseBigInt(_key: string, value: unknown): unknown {
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value[BIGINT_MARKER] === 'string'
  ) {
    return BigInt(value[BIGINT_MARKER]);
  }
  return value;
}

/**
 * File-backed store for one rebalancer entity type.
 *
 * Each mutation is serialized in-process and replaces the state file atomically.
 * The temporary file and containing tracking directory use owner-only permissions.
 */
export class FileStore<
  T extends TrackedActionBase,
  Status extends string,
> implements IStore<T, Status> {
  private readonly data = new Map<string, T>();
  private loaded = false;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly isEntity: EntityValidator<T>,
  ) {}

  async save(entity: T): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      this.data.set(entity.id, entity);
      await this.persist();
    });
  }

  async get(id: string): Promise<T | undefined> {
    return this.withLock(async () => {
      await this.load();
      return this.data.get(id);
    });
  }

  async getAll(): Promise<T[]> {
    return this.withLock(async () => {
      await this.load();
      return Array.from(this.data.values());
    });
  }

  async update(id: string, updates: Partial<T>): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      const existing = this.data.get(id);
      if (!existing) {
        throw new Error(`Entity ${id} not found`);
      }

      const updated: unknown = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      };
      if (!this.isEntity(updated)) {
        throw new Error(`Update produced invalid entity ${id}`);
      }
      this.data.set(id, updated);
      await this.persist();
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      if (this.data.delete(id)) {
        await this.persist();
      }
    });
  }

  async getByStatus(status: Status): Promise<T[]> {
    return this.withLock(async () => {
      await this.load();
      return Array.from(this.data.values()).filter(
        (entity) => entity.status === status,
      );
    });
  }

  async getByDestination(destination: Domain): Promise<T[]> {
    return this.withLock(async () => {
      await this.load();
      return Array.from(this.data.values()).filter(
        (entity) => entity.destination === destination,
      );
    });
  }

  private async withLock<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.lock;
    let release = (): void => {};
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;

    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isFileNotFound(error)) {
        this.loaded = true;
        return;
      }
      throw error;
    }

    await chmod(path.dirname(this.filePath), 0o700);
    await chmod(this.filePath, 0o600);

    const parsed: unknown = JSON.parse(contents, parseBigInt);
    if (
      !isRecord(parsed) ||
      parsed.version !== STORE_VERSION ||
      !Array.isArray(parsed.entities)
    ) {
      throw new Error(`Invalid state store file ${this.filePath}`);
    }

    const loadedData = new Map<string, T>();
    for (const entity of parsed.entities) {
      if (!this.isEntity(entity)) {
        throw new Error(`Invalid entity in state store file ${this.filePath}`);
      }
      if (loadedData.has(entity.id)) {
        throw new Error(
          `Duplicate entity ${entity.id} in state store file ${this.filePath}`,
        );
      }
      loadedData.set(entity.id, entity);
    }
    for (const [id, entity] of loadedData) {
      this.data.set(id, entity);
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    const serialized = JSON.stringify(
      { version: STORE_VERSION, entities: Array.from(this.data.values()) },
      stringifyBigInt,
    );

    try {
      const temporaryFile = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporaryFile.writeFile(serialized, 'utf8');
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }

      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);

      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
