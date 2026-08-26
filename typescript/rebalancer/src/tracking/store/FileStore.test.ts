import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import type { RebalanceAction, RebalanceIntent, Transfer } from '../types.js';

import { FileStore } from './FileStore.js';
import {
  isRebalanceAction,
  isRebalanceIntent,
  isTransfer,
} from './entityValidators.js';

chai.use(chaiAsPromised);

describe('FileStore', () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'hyperlane-rebalancer-store-'),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('round-trips BigInt state across a restart', async () => {
    const filePath = path.join(
      temporaryDirectory,
      'tracking',
      'transfers.json',
    );
    const transfer: Transfer = {
      id: 'transfer-1',
      status: 'in_progress',
      messageId: 'message-1',
      origin: 1,
      destination: 2,
      amount: 123456789012345678901234567890n,
      sender: '0xsender',
      recipient: '0xrecipient',
      createdAt: 1,
      updatedAt: 1,
    };

    const firstStore = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );
    await firstStore.save(transfer);

    const restartedStore = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );
    await chmod(path.dirname(filePath), 0o755);
    await chmod(filePath, 0o644);
    expect(await restartedStore.get(transfer.id)).to.deep.equal(transfer);
    expect(typeof (await restartedStore.get(transfer.id))?.amount).to.equal(
      'bigint',
    );
    expect((await stat(path.dirname(filePath))).mode & 0o777).to.equal(0o700);
    expect((await stat(filePath)).mode & 0o777).to.equal(0o600);
  });

  it('restores a pre-send intent and action after restart', async () => {
    const trackingDirectory = path.join(temporaryDirectory, 'tracking');
    const intentPath = path.join(trackingDirectory, 'intents.json');
    const actionPath = path.join(trackingDirectory, 'actions.json');
    const intent: RebalanceIntent = {
      id: 'intent-1',
      status: 'in_progress',
      origin: 1,
      destination: 2,
      amount: 100n,
      executionMethod: 'inventory',
      createdAt: 1,
      updatedAt: 1,
    };
    const action: RebalanceAction = {
      id: 'action-1',
      status: 'in_progress',
      type: 'inventory_movement',
      intentId: intent.id,
      origin: 1,
      destination: 2,
      amount: 100n,
      createdAt: 1,
      updatedAt: 1,
    };

    await new FileStore<RebalanceIntent, RebalanceIntent['status']>(
      intentPath,
      isRebalanceIntent,
    ).save(intent);
    await new FileStore<RebalanceAction, RebalanceAction['status']>(
      actionPath,
      isRebalanceAction,
    ).save(action);

    const restartedIntents = new FileStore<
      RebalanceIntent,
      RebalanceIntent['status']
    >(intentPath, isRebalanceIntent);
    const restartedActions = new FileStore<
      RebalanceAction,
      RebalanceAction['status']
    >(actionPath, isRebalanceAction);
    expect(await restartedIntents.get(intent.id)).to.deep.equal(intent);
    expect(await restartedActions.get(action.id)).to.deep.equal(action);
  });

  it('serializes concurrent writes and leaves only an atomic state file', async () => {
    const trackingDirectory = path.join(temporaryDirectory, 'tracking');
    const filePath = path.join(trackingDirectory, 'transfers.json');
    const store = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );

    await Promise.all(
      [1, 2, 3].map((id) =>
        store.save({
          id: `transfer-${id}`,
          status: 'in_progress',
          messageId: `message-${id}`,
          origin: 1,
          destination: 2,
          amount: BigInt(id),
          sender: '0xsender',
          recipient: '0xrecipient',
          createdAt: id,
          updatedAt: id,
        }),
      ),
    );

    expect(await store.getAll()).to.have.lengthOf(3);
    expect(await readdir(trackingDirectory)).to.deep.equal(['transfers.json']);
    expect((await stat(trackingDirectory)).mode & 0o777).to.equal(0o700);
    expect((await stat(filePath)).mode & 0o777).to.equal(0o600);
    expect(JSON.parse(await readFile(filePath, 'utf8')).version).to.equal(1);
  });

  it('persists deletions across a restart', async () => {
    const filePath = path.join(
      temporaryDirectory,
      'tracking',
      'transfers.json',
    );
    const transfer: Transfer = {
      id: 'transfer-to-delete',
      status: 'complete',
      messageId: 'message-to-delete',
      origin: 1,
      destination: 2,
      amount: 1n,
      sender: '0xsender',
      recipient: '0xrecipient',
      createdAt: 1,
      updatedAt: 1,
    };
    const store = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );
    await store.save(transfer);

    await store.delete(transfer.id);

    const restartedStore = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );
    expect(await restartedStore.get(transfer.id)).to.be.undefined;
  });

  it('fails closed on malformed persisted state', async () => {
    const filePath = path.join(temporaryDirectory, 'transfers.json');
    await writeFile(filePath, '{"version":1,"entities":[{}]}', 'utf8');

    const store = new FileStore<Transfer, Transfer['status']>(
      filePath,
      isTransfer,
    );
    await expect(store.getAll()).to.be.rejectedWith(
      `Invalid entity in state store file ${filePath}`,
    );
  });
});
