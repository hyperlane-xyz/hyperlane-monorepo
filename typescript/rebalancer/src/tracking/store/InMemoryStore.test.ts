import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import type { Transfer } from '../types.js';

import { InMemoryStore } from './InMemoryStore.js';

chai.use(chaiAsPromised);

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
      expect(retrieved).to.deep.equal(transfer);
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
      expect(retrieved?.status).to.equal('complete');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent entity', async () => {
      const result = await store.get('non-existent');
      expect(result).to.be.undefined;
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

      expect(retrieved).to.deep.equal(transfer);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no entities exist', async () => {
      const result = await store.getAll();
      expect(result).to.be.an('array').that.is.empty;
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
      expect(result).to.have.lengthOf(2);
      expect(result).to.deep.include(transfer1);
      expect(result).to.deep.include(transfer2);
    });
  });

  describe('update', () => {
    it('should throw error when updating non-existent entity', async () => {
      await expect(
        store.update('non-existent', { status: 'complete' }),
      ).to.be.rejectedWith('Entity non-existent not found');
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
      expect(updated?.status).to.equal('complete');
      expect(updated?.updatedAt).to.be.at.least(transfer.updatedAt);
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
      expect(updated?.messageId).to.equal('msg-1');
      expect(updated?.origin).to.equal(1);
      expect(updated?.destination).to.equal(2);
      expect(updated?.amount).to.equal(100n);
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
      expect(retrieved).to.be.undefined;
    });

    it('should not throw when deleting non-existent entity', async () => {
      await expect(store.delete('non-existent')).to.not.be.rejected;
    });
  });

  describe('getByStatus', () => {
    it('should return empty array when no entities match status', async () => {
      const result = await store.getByStatus('complete');
      expect(result).to.be.an('array').that.is.empty;
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
      expect(inProgress).to.have.lengthOf(2);
      expect(inProgress).to.deep.include(transfer1);
      expect(inProgress).to.deep.include(transfer3);

      const complete = await store.getByStatus('complete');
      expect(complete).to.have.lengthOf(1);
      expect(complete).to.deep.include(transfer2);
    });
  });

  describe('getByDestination', () => {
    it('should return empty array when no entities match destination', async () => {
      const result = await store.getByDestination(999);
      expect(result).to.be.an('array').that.is.empty;
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
      expect(toDomain2).to.have.lengthOf(2);
      expect(toDomain2).to.deep.include(transfer1);
      expect(toDomain2).to.deep.include(transfer3);

      const toDomain3 = await store.getByDestination(3);
      expect(toDomain3).to.have.lengthOf(1);
      expect(toDomain3).to.deep.include(transfer2);
    });
  });
});
