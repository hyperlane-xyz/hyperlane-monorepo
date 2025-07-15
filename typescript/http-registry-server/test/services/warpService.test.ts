import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import { PartialRegistry, WarpRouteId } from '@hyperlane-xyz/registry';

import { NotFoundError } from '../../src/errors/ApiError.js';
import { RegistryService } from '../../src/services/registryService.js';
import { WarpService } from '../../src/services/warpService.js';
import {
  MOCK_CHAIN_NAME,
  mockChainAddresses,
  mockChainMetadata,
  mockWarpRoutes,
} from '../utils/mockData.js';

chaiUse(chaiAsPromised);

describe('WarpService', () => {
  let warpService: WarpService;
  let mockRegistryService: sinon.SinonStubbedInstance<RegistryService>;
  let mockRegistry: PartialRegistry;

  const mockWarpRoute = mockWarpRoutes[0];

  beforeEach(() => {
    // Create mock registry with warp route data
    mockRegistry = new PartialRegistry({
      chainMetadata: {
        [MOCK_CHAIN_NAME]: mockChainMetadata,
      },
      chainAddresses: {
        [MOCK_CHAIN_NAME]: mockChainAddresses,
      },
      warpRoutes: [mockWarpRoute],
    });

    // Create stubbed registry service
    mockRegistryService = sinon.createStubInstance(RegistryService);
    mockRegistryService.withRegistry.callsFake(async (operation) => {
      return operation(mockRegistry);
    });

    warpService = new WarpService(mockRegistryService);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getWarpRoute', () => {
    it('should return warp route when it exists', async () => {
      const warpRouteId: WarpRouteId = 'test-warp-route';

      // Mock registry to return the warp route
      sinon.stub(mockRegistry, 'getWarpRoute').resolves(mockWarpRoute);

      const result = await warpService.getWarpRoute(warpRouteId);

      expect(result).to.deep.equal(mockWarpRoute);
      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;
    });

    it('should throw NotFoundError when warp route does not exist', async () => {
      const warpRouteId: WarpRouteId = 'nonexistent-warp-route';

      // Mock registry to return null
      sinon.stub(mockRegistry, 'getWarpRoute').resolves(null);

      await expect(warpService.getWarpRoute(warpRouteId))
        .to.be.rejectedWith(NotFoundError)
        .and.eventually.have.property('message')
        .that.include('Warp route not found for id nonexistent-warp-route');
    });

    it('should propagate registry errors', async () => {
      const warpRouteId: WarpRouteId = 'test-warp-route';

      // Mock registry to throw an error
      sinon
        .stub(mockRegistry, 'getWarpRoute')
        .rejects(new Error('Registry error'));

      await expect(warpService.getWarpRoute(warpRouteId)).to.be.rejectedWith(
        'Registry error',
      );
    });

    it('should call withRegistry with correct operation', async () => {
      const warpRouteId: WarpRouteId = 'test-warp-route';
      const getWarpRouteStub = sinon
        .stub(mockRegistry, 'getWarpRoute')
        .resolves(mockWarpRoute);

      await warpService.getWarpRoute(warpRouteId);

      expect(mockRegistryService.withRegistry.calledOnce).to.be.true;

      // Verify the stub on the full mock registry was called correctly
      expect(getWarpRouteStub.calledWith(warpRouteId)).to.be.true;
    });
  });
});
