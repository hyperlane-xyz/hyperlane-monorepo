import { expect } from 'vitest';

import type { Transfer } from '../types.js';

import { InMemoryStore } from './InMemoryStore.js';

describe('InMemoryStore', () => {
  let store: InMemoryStore<Transfer, 'in_progress' | 'complete'>;

  beforeEach(() => {
    store = new InMemoryStore<Transfer, 'in_progress' | 'complete'>();
  });

  describe('save', () => {
    it('should save a new entity', async () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer);

      const retrieved = await store.get('transfer-1');
      expect(retrieved).toEqual(transfer);
    });

    it('should overwrite an existing entity with the same id', async () => {
      const transfer1: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer2: Transfer = {
        ...transfer1,
        status: 'complete',
        updatedAt: Date.now() + 1000,
      };

      await store.save(transfer1);
      await store.save(transfer2);

      const retrieved = await store.get('transfer-1');
      expect(retrieved?.status).toBe('complete');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent entity', async () => {
      const result = await store.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should retrieve an existing entity', async () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer);
      const retrieved = await store.get('transfer-1');

      expect(retrieved).toEqual(transfer);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no entities exist', async () => {
      const result = await store.getAll();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return all entities', async () => {
      const transfer1: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender1',
        recipient: '0xrecipient1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer2: Transfer = {
        id: 'transfer-2',
        status: 'complete',
        messageId: 'msg-2',
        origin: 2,
        destination: 3,
        amount: 200n,
        sender: '0xsender2',
        recipient: '0xrecipient2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer1);
      await store.save(transfer2);

      const result = await store.getAll();
      expect(result).toHaveLength(2);
      expect(result).toContainEqual(transfer1);
      expect(result).toContainEqual(transfer2);
    });
  });

  describe('update', () => {
    it('should throw error when updating non-existent entity', async () => {
      await expect(
        store.update('non-existent', { status: 'complete' }),
      ).rejects.toThrow('Entity non-existent not found');
    });

    it('should update existing entity', async () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer);
      await store.update('transfer-1', { status: 'complete' });

      const updated = await store.get('transfer-1');
      expect(updated?.status).toBe('complete');
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(transfer.updatedAt);
    });

    it('should preserve non-updated fields', async () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer);
      await store.update('transfer-1', { status: 'complete' });

      const updated = await store.get('transfer-1');
      expect(updated?.messageId).toBe('msg-1');
      expect(updated?.origin).toBe(1);
      expect(updated?.destination).toBe(2);
      expect(updated?.amount).toBe(100n);
    });
  });

  describe('delete', () => {
    it('should delete existing entity', async () => {
      const transfer: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender',
        recipient: '0xrecipient',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer);
      await store.delete('transfer-1');

      const retrieved = await store.get('transfer-1');
      expect(retrieved).toBeUndefined();
    });

    it('should not throw when deleting non-existent entity', async () => {
      await expect(store.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('getByStatus', () => {
    it('should return empty array when no entities match status', async () => {
      const result = await store.getByStatus('complete');
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return only entities with matching status', async () => {
      const transfer1: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender1',
        recipient: '0xrecipient1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer2: Transfer = {
        id: 'transfer-2',
        status: 'complete',
        messageId: 'msg-2',
        origin: 2,
        destination: 3,
        amount: 200n,
        sender: '0xsender2',
        recipient: '0xrecipient2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer3: Transfer = {
        id: 'transfer-3',
        status: 'in_progress',
        messageId: 'msg-3',
        origin: 3,
        destination: 1,
        amount: 300n,
        sender: '0xsender3',
        recipient: '0xrecipient3',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer1);
      await store.save(transfer2);
      await store.save(transfer3);

      const inProgress = await store.getByStatus('in_progress');
      expect(inProgress).toHaveLength(2);
      expect(inProgress).toContainEqual(transfer1);
      expect(inProgress).toContainEqual(transfer3);

      const complete = await store.getByStatus('complete');
      expect(complete).toHaveLength(1);
      expect(complete).toContainEqual(transfer2);
    });
  });

  describe('getByDestination', () => {
    it('should return empty array when no entities match destination', async () => {
      const result = await store.getByDestination(999);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return only entities with matching destination', async () => {
      const transfer1: Transfer = {
        id: 'transfer-1',
        status: 'in_progress',
        messageId: 'msg-1',
        origin: 1,
        destination: 2,
        amount: 100n,
        sender: '0xsender1',
        recipient: '0xrecipient1',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer2: Transfer = {
        id: 'transfer-2',
        status: 'complete',
        messageId: 'msg-2',
        origin: 2,
        destination: 3,
        amount: 200n,
        sender: '0xsender2',
        recipient: '0xrecipient2',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const transfer3: Transfer = {
        id: 'transfer-3',
        status: 'in_progress',
        messageId: 'msg-3',
        origin: 3,
        destination: 2,
        amount: 300n,
        sender: '0xsender3',
        recipient: '0xrecipient3',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await store.save(transfer1);
      await store.save(transfer2);
      await store.save(transfer3);

      const toDomain2 = await store.getByDestination(2);
      expect(toDomain2).toHaveLength(2);
      expect(toDomain2).toContainEqual(transfer1);
      expect(toDomain2).toContainEqual(transfer3);

      const toDomain3 = await store.getByDestination(3);
      expect(toDomain3).toHaveLength(1);
      expect(toDomain3).toContainEqual(transfer2);
    });
  });
});
