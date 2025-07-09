import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { PartialRegistry } from '@hyperlane-xyz/registry';

import { NotFoundError } from '../../src/errors/ApiError.js';
import { ChainService } from '../../src/services/chainService.js';
import { RegistryService } from '../../src/services/registryService.js';
import {
  MOCK_CHAIN_NAME,
  mockChainAddresses,
  mockChainMetadata,
} from '../utils/mockData.js';

chaiUse(chaiAsPromised);

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

      expect(result).to.deep.equal(mockChainMetadata);
      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;
    });

    it('should throw NotFoundError when chain metadata does not exist', async () => {
      sinon.stub(mockRegistry, 'getChainMetadata').resolves(null);

      await expect(chainService.getChainMetadata('nonexistent'))
        .to.be.rejectedWith(NotFoundError)
        .and.eventually.have.property('message')
        .that.include('Chain metadata not found for chain nonexistent');
    });

    it('should propagate registry errors', async () => {
      sinon
        .stub(mockRegistry, 'getChainMetadata')
        .rejects(new Error('Registry error'));

      await expect(
        chainService.getChainMetadata(MOCK_CHAIN_NAME),
      ).to.be.rejectedWith('Registry error');
    });
  });

  describe('getChainAddresses', () => {
    it('should return chain addresses when they exist', async () => {
      sinon
        .stub(mockRegistry, 'getChainAddresses')
        .resolves(mockChainAddresses);

      const result = await chainService.getChainAddresses(MOCK_CHAIN_NAME);

      expect(result).to.deep.equal(mockChainAddresses);
      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;
    });

    it('should throw NotFoundError when chain addresses do not exist', async () => {
      sinon.stub(mockRegistry, 'getChainAddresses').resolves(null);

      await expect(chainService.getChainAddresses('nonexistent'))
        .to.be.rejectedWith(NotFoundError)
        .and.eventually.have.property('message')
        .that.include('Chain addresses not found for chain nonexistent');
    });

    it('should propagate registry errors', async () => {
      sinon
        .stub(mockRegistry, 'getChainAddresses')
        .rejects(new Error('Registry error'));

      await expect(
        chainService.getChainAddresses(MOCK_CHAIN_NAME),
      ).to.be.rejectedWith('Registry error');
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

      expect(updateChainStub.calledWith(updateParams)).to.be.true;
      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;
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

      await expect(chainService.updateChain(updateParams)).to.be.rejectedWith(
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

      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;
      expect(updateChainStub.calledWith(updateParams)).to.be.true;
    });
  });
});
