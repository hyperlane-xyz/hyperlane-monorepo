import sinon from 'sinon';
import { expect } from 'vitest';

import { PartialRegistry } from '@hyperlane-xyz/registry';

import { NotFoundError } from '../../src/errors/ApiError.js';
import { ChainService } from '../../src/services/chainService.js';
import { RegistryService } from '../../src/services/registryService.js';
import {
  MOCK_CHAIN_NAME,
  mockChainAddresses,
  mockChainMetadata,
} from '../utils/mockData.js';

describe('ChainService', () => {
  let chainService: ChainService;
  let mockRegistryService: sinon.SinonStubbedInstance<RegistryService>;
  let mockRegistry: PartialRegistry;

  beforeEach(() => {
    // Create mock registry with chain data
    mockRegistry = new PartialRegistry({
      chainMetadata: {
        [MOCK_CHAIN_NAME]: mockChainMetadata,
      },
      chainAddresses: {
        [MOCK_CHAIN_NAME]: mockChainAddresses,
      },
      warpRoutes: [],
    });

    // Create stubbed registry service
    mockRegistryService = sinon.createStubInstance(RegistryService);
    mockRegistryService.withRegistry.callsFake(async (operation) => {
      return operation(mockRegistry);
    });

    chainService = new ChainService(mockRegistryService);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getChainMetadata', () => {
    it('should return chain metadata when it exists', async () => {
      sinon.stub(mockRegistry, 'getChainMetadata').resolves(mockChainMetadata);

      const result = await chainService.getChainMetadata(MOCK_CHAIN_NAME);

      expect(result).toEqual(mockChainMetadata);
      expect(mockRegistryService.withRegistry.calledOnce).toBe(true);
    });

    it('should throw NotFoundError when chain metadata does not exist', async () => {
      sinon.stub(mockRegistry, 'getChainMetadata').resolves(null);

      await expect(
        chainService.getChainMetadata('nonexistent'),
      ).rejects.toThrow(/Chain metadata not found for chain nonexistent/);
      try {
        await chainService.getChainMetadata('nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).toHaveProperty(
          'message',
          expect.stringContaining(
            'Chain metadata not found for chain nonexistent',
          ),
        );
      }
    });

    it('should propagate registry errors', async () => {
      sinon
        .stub(mockRegistry, 'getChainMetadata')
        .rejects(new Error('Registry error'));

      await expect(
        chainService.getChainMetadata(MOCK_CHAIN_NAME),
      ).rejects.toThrow('Registry error');
    });
  });

  describe('getChainAddresses', () => {
    it('should return chain addresses when they exist', async () => {
      sinon
        .stub(mockRegistry, 'getChainAddresses')
        .resolves(mockChainAddresses);

      const result = await chainService.getChainAddresses(MOCK_CHAIN_NAME);

      expect(result).toEqual(mockChainAddresses);
      expect(mockRegistryService.withRegistry.calledOnce).toBe(true);
    });

    it('should throw NotFoundError when chain addresses do not exist', async () => {
      sinon.stub(mockRegistry, 'getChainAddresses').resolves(null);

      await expect(
        chainService.getChainAddresses('nonexistent'),
      ).rejects.toThrow(/Chain addresses not found for chain nonexistent/);
      try {
        await chainService.getChainAddresses('nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).toHaveProperty(
          'message',
          expect.stringContaining(
            'Chain addresses not found for chain nonexistent',
          ),
        );
      }
    });

    it('should propagate registry errors', async () => {
      sinon
        .stub(mockRegistry, 'getChainAddresses')
        .rejects(new Error('Registry error'));

      await expect(
        chainService.getChainAddresses(MOCK_CHAIN_NAME),
      ).rejects.toThrow('Registry error');
    });
  });

  describe('updateChain', () => {
    it('should update chain successfully', async () => {
      const updateParams = {
        chainName: MOCK_CHAIN_NAME,
        metadata: {
          ...mockChainMetadata,
          displayName: 'Updated Chain',
        },
      };
      const updateChainStub = sinon
        .stub(mockRegistry, 'updateChain')
        .resolves();

      await chainService.updateChain(updateParams);

      expect(updateChainStub.calledWith(updateParams)).toBe(true);
      expect(mockRegistryService.withRegistry.calledOnce).toBe(true);
    });

    it('should propagate update errors', async () => {
      const updateParams = {
        chainName: MOCK_CHAIN_NAME,
        metadata: {
          ...mockChainMetadata,
          displayName: 'Updated Chain',
        },
      };
      sinon
        .stub(mockRegistry, 'updateChain')
        .rejects(new Error('Update failed'));

      await expect(chainService.updateChain(updateParams)).rejects.toThrow(
        'Update failed',
      );
    });

    it('should call withRegistry with correct update operation', async () => {
      const updateParams = {
        chainName: MOCK_CHAIN_NAME,
        metadata: {
          ...mockChainMetadata,
          displayName: 'Updated Chain',
        },
      };
      const updateChainStub = sinon
        .stub(mockRegistry, 'updateChain')
        .resolves();

      await chainService.updateChain(updateParams);

      expect(mockRegistryService.withRegistry.calledOnce).toBe(true);
      expect(updateChainStub.calledWith(updateParams)).toBe(true);
    });
  });
});
