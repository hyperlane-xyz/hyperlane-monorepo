import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { type Logger, pino } from 'pino';
import sinon from 'sinon';

import {
  IRegistry,
  MergedRegistry,
  PartialRegistry,
  RegistryType,
} from '@hyperlane-xyz/registry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { RegistryService } from '../../src/services/registryService.js';
import { IWatcher } from '../../src/services/watcherService.js';

chaiUse(chaiAsPromised);

describe('RegistryService', () => {
  let registryService: RegistryService;
  let mockRegistry: IRegistry;
  let getRegistryStub: sinon.SinonStub;
  let mockLogger: Logger;
  let clock: sinon.SinonFakeTimers;

  const REFRESH_INTERVAL = 1000; // 1 second for testing

  beforeEach(() => {
    // Create mock registry with test data
    mockRegistry = new PartialRegistry({
      chainMetadata: {
        ethereum: {
          chainId: 1,
          domainId: 1,
          displayName: 'Ethereum',
          name: 'ethereum',
          protocol: ProtocolType.Ethereum,
          rpcUrls: [{ http: 'https://eth-mainnet.alchemyapi.io/v2/test' }],
          blocks: {
            confirmations: 1,
            estimateBlockTime: 12,
            reorgPeriod: 2,
          },
        },
      },
      chainAddresses: {
        ethereum: {
          mailbox: '0x0000000000000000000000000000000000000001',
        },
      },
      warpRoutes: [],
    });

    getRegistryStub = sinon.stub().resolves(mockRegistry);
    mockLogger = pino({ level: 'silent' });

    registryService = new RegistryService(
      getRegistryStub,
      REFRESH_INTERVAL,
      mockLogger,
    );
  });

  afterEach(() => {
    sinon.restore();
    if (clock) {
      clock.restore();
    }
  });

  describe('initialize', () => {
    it('should initialize registry on startup', async () => {
      await registryService.initialize();

      expect(getRegistryStub.calledOnce).to.be.true;
    });
  });

  describe('getCurrentRegistry', () => {
    it('should return cached registry when within refresh interval', async () => {
      await registryService.initialize();
      getRegistryStub.resetHistory();

      const registry1 = await registryService.getCurrentRegistry();
      const registry2 = await registryService.getCurrentRegistry();

      expect(registry1).to.equal(mockRegistry);
      expect(registry2).to.equal(mockRegistry);
      expect(getRegistryStub.called).to.be.false;
    });

    it('should refresh registry after refresh interval expires', async () => {
      clock = sinon.useFakeTimers(Date.now());

      await registryService.initialize();
      getRegistryStub.resetHistory();

      // Move time forward past refresh interval
      clock.tick(REFRESH_INTERVAL + 1);

      await registryService.getCurrentRegistry();

      expect(getRegistryStub.calledOnce).to.be.true;
    });

    it('should refresh registry if no cached registry exists', async () => {
      const registry = await registryService.getCurrentRegistry();

      expect(registry).to.equal(mockRegistry);
      expect(getRegistryStub.calledOnce).to.be.true;
    });
  });

  describe('withRegistry', () => {
    it('should execute operation with current registry', async () => {
      await registryService.initialize();

      const operation = sinon.stub().resolves('test-result');
      const result = await registryService.withRegistry(operation);

      expect(operation.calledWith(mockRegistry)).to.be.true;
      expect(result).to.equal('test-result');
    });

    it('should propagate errors from operations', async () => {
      await registryService.initialize();

      const operation = sinon.stub().rejects(new Error('Operation failed'));

      await expect(registryService.withRegistry(operation)).to.be.rejectedWith(
        'Operation failed',
      );
    });

    it('should refresh registry if needed before operation', async () => {
      clock = sinon.useFakeTimers(Date.now());

      await registryService.initialize();
      getRegistryStub.resetHistory();

      // Move time forward past refresh interval
      clock.tick(REFRESH_INTERVAL + 1);

      const operation = sinon.stub().resolves('test-result');
      await registryService.withRegistry(operation);

      expect(getRegistryStub.calledOnce).to.be.true;
      expect(operation.calledWith(mockRegistry)).to.be.true;
    });
  });

  describe('dirty flag', () => {
    let markDirtyCallback: () => void;
    let mockWatcher: IWatcher;

    beforeEach(() => {
      mockWatcher = {
        watch: sinon.stub().callsFake((_path, callback) => {
          markDirtyCallback = callback;
        }),
        stop: sinon.stub(),
      };
    });

    it('should trigger refresh when dirty', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();
      getRegistryStub.resetHistory();

      // Simulate watcher callback
      markDirtyCallback();

      await registryService.getCurrentRegistry();

      expect(getRegistryStub.calledOnce).to.be.true;
    });

    it('should clear flag after refresh', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();
      getRegistryStub.resetHistory();

      // Trigger dirty flag
      markDirtyCallback();

      // First call should refresh
      await registryService.getCurrentRegistry();
      expect(getRegistryStub.calledOnce).to.be.true;
      getRegistryStub.resetHistory();

      // Second call should NOT refresh (flag cleared)
      await registryService.getCurrentRegistry();
      expect(getRegistryStub.called).to.be.false;
    });

    it('should skip time-based refresh when watching', async () => {
      clock = sinon.useFakeTimers(Date.now());

      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();
      getRegistryStub.resetHistory();

      // Time passes but no file change
      clock.tick(REFRESH_INTERVAL + 1);

      await registryService.getCurrentRegistry();

      // Should NOT refresh because we're watching and dirty flag not set
      expect(getRegistryStub.called).to.be.false;
    });
  });

  describe('file watching', () => {
    it('should set up watcher for FileSystem registry', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      const mockWatcher: IWatcher = {
        watch: sinon.stub(),
        stop: sinon.stub(),
      };

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      expect((mockWatcher.watch as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockWatcher.watch as sinon.SinonStub).firstCall.args[0]).to.equal(
        '/test/registry',
      );
    });

    it('should extract path from MergedRegistry', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/fs-registry',
      } as IRegistry;

      const mergedRegistry = {
        ...mockRegistry,
        type: RegistryType.Merged,
        registries: [fsRegistry],
      } as unknown as MergedRegistry;
      getRegistryStub.resolves(mergedRegistry);

      const mockWatcher: IWatcher = {
        watch: sinon.stub(),
        stop: sinon.stub(),
      };

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      expect((mockWatcher.watch as sinon.SinonStub).calledOnce).to.be.true;
      expect((mockWatcher.watch as sinon.SinonStub).firstCall.args[0]).to.equal(
        '/test/fs-registry',
      );
    });

    it('should strip file:// prefix from uri', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: 'file:///test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      const mockWatcher: IWatcher = {
        watch: sinon.stub(),
        stop: sinon.stub(),
      };

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      expect((mockWatcher.watch as sinon.SinonStub).firstCall.args[0]).to.equal(
        '/test/registry',
      );
    });

    it('should skip watcher setup for non-FileSystem registry', async () => {
      // PartialRegistry has no type, so it shouldn't trigger watching
      const mockWatcher: IWatcher = {
        watch: sinon.stub(),
        stop: sinon.stub(),
      };

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      expect((mockWatcher.watch as sinon.SinonStub).called).to.be.false;
    });

    it('should skip watcher setup when no watcher provided', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      // No watcher provided
      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
      );

      // Should not throw
      await registryService.initialize();
    });

    it('should log warning on watch failure', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      const mockWatcher: IWatcher = {
        watch: sinon.stub().throws(new Error('Watch failed')),
        stop: sinon.stub(),
      };
      const loggerWarnStub = sinon.stub(mockLogger, 'warn');

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[1]).to.include('Failed to watch');
    });

    it('should log warning on runtime watcher error', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      let capturedOnError: ((err: Error) => void) | undefined;
      const mockWatcher: IWatcher = {
        watch: sinon.stub().callsFake((_path, _callback, onError) => {
          capturedOnError = onError;
        }),
        stop: sinon.stub(),
      };
      const loggerWarnStub = sinon.stub(mockLogger, 'warn');

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();

      // Simulate runtime watcher error
      expect(capturedOnError).to.exist;
      capturedOnError!(new Error('ENOENT: no such file or directory'));

      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[1]).to.include('Watcher error');
    });
  });

  describe('stop', () => {
    it('should call watcher.stop on stop', async () => {
      const fsRegistry = {
        ...mockRegistry,
        type: RegistryType.FileSystem,
        uri: '/test/registry',
      } as IRegistry;
      getRegistryStub.resolves(fsRegistry);

      const mockWatcher: IWatcher = {
        watch: sinon.stub(),
        stop: sinon.stub(),
      };

      registryService = new RegistryService(
        getRegistryStub,
        REFRESH_INTERVAL,
        mockLogger,
        mockWatcher,
      );

      await registryService.initialize();
      registryService.stop();

      expect((mockWatcher.stop as sinon.SinonStub).calledOnce).to.be.true;
    });

    it('should handle stop when no watcher', async () => {
      // No watcher provided
      await registryService.initialize();

      // Should not throw
      expect(() => registryService.stop()).to.not.throw();
    });
  });
});
