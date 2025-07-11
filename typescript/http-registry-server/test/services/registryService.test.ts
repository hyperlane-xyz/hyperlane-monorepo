import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { type Logger, pino } from 'pino';
import sinon from 'sinon';

import { IRegistry, PartialRegistry } from '@hyperlane-xyz/registry';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { RegistryService } from '../../src/services/registryService.js';

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
});
