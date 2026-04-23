import express, { Express } from 'express';
import { pino } from 'pino';
import sinon from 'sinon';
import request from 'supertest';
import { expect } from 'vitest';

import { WarpRouteFilterParams } from '@hyperlane-xyz/registry';

import { AppConstants } from '../../src/constants/AppConstants.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createRootRouter } from '../../src/routes/root.js';
import { RootService } from '../../src/services/rootService.js';
import {
  mockChainAddressesMap,
  mockChainMetadataMap,
  mockChains,
  mockRegistryContent,
  mockWarpRouteMap,
} from '../utils/mockData.js';

describe('Root Routes', () => {
  let app: Express;
  let mockRootService: sinon.SinonStubbedInstance<RootService>;

  beforeEach(() => {
    // Create stubbed root service
    mockRootService = sinon.createStubInstance(RootService);
    const mockLogger = pino({ level: 'silent' });

    // Create Express app with root routes
    app = express();
    app.use(express.json());
    app.use('/', createRootRouter(mockRootService));
    app.use(createErrorHandler(mockLogger));
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('GET /metadata', () => {
    it('should return registry metadata', async () => {
      mockRootService.getMetadata.resolves(mockChainMetadataMap);

      const response = await request(app)
        .get('/metadata')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockChainMetadataMap);
      expect(mockRootService.getMetadata.calledOnce).toBe(true);
    });

    it('should handle service errors', async () => {
      mockRootService.getMetadata.rejects(new Error('Metadata fetch failed'));

      const response = await request(app)
        .get('/metadata')
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Metadata fetch failed');
    });

    it('should return empty object when no metadata exists', async () => {
      mockRootService.getMetadata.resolves({});

      const response = await request(app)
        .get('/metadata')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual({});
    });
  });

  describe('GET /addresses', () => {
    it('should return all chain addresses', async () => {
      mockRootService.getAddresses.resolves(mockChainAddressesMap);

      const response = await request(app)
        .get('/addresses')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockChainAddressesMap);
      expect(mockRootService.getAddresses.calledOnce).toBe(true);
    });

    it('should handle service errors', async () => {
      mockRootService.getAddresses.rejects(new Error('Addresses fetch failed'));

      const response = await request(app)
        .get('/addresses')
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Addresses fetch failed');
    });
  });

  describe('GET /chains', () => {
    it('should return list of all chains', async () => {
      mockRootService.getChains.resolves(mockChains);

      const response = await request(app)
        .get('/chains')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockChains);
      expect(mockRootService.getChains.calledOnce).toBe(true);
    });

    it('should handle empty chains list', async () => {
      mockRootService.getChains.resolves([]);

      const response = await request(app)
        .get('/chains')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual([]);
    });

    it('should handle service errors', async () => {
      mockRootService.getChains.rejects(new Error('Chains fetch failed'));

      const response = await request(app)
        .get('/chains')
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Chains fetch failed');
    });
  });

  describe('GET /list-registry-content', () => {
    it('should return registry content listing', async () => {
      mockRootService.listRegistryContent.resolves(mockRegistryContent);

      const response = await request(app)
        .get('/list-registry-content')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockRegistryContent);
      expect(mockRootService.listRegistryContent.calledOnce).toBe(true);
    });

    it('should handle service errors', async () => {
      mockRootService.listRegistryContent.rejects(
        new Error('Content listing failed'),
      );

      const response = await request(app)
        .get('/list-registry-content')
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Content listing failed');
    });
  });

  describe('GET /warp-routes', () => {
    it('should return all warp routes without filter', async () => {
      mockRootService.getWarpRoutes.resolves(mockWarpRouteMap);

      const response = await request(app)
        .get('/warp-routes')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockWarpRouteMap);
      expect(mockRootService.getWarpRoutes.calledWith({})).toBe(true);
    });

    it('should return filtered warp routes with query parameters', async () => {
      const filteredRoutes = {
        'test-warp-route': mockWarpRouteMap['test-warp-route'],
      };
      mockRootService.getWarpRoutes.resolves(filteredRoutes);

      const filter: WarpRouteFilterParams = {
        symbol: 'ETH',
        label: 'testlabel',
      };

      const response = await request(app)
        .get('/warp-routes')
        .query(filter)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(filteredRoutes);
      expect(mockRootService.getWarpRoutes.calledWith(filter)).toBe(true);
    });

    it('should handle empty warp routes list', async () => {
      mockRootService.getWarpRoutes.resolves({});

      const response = await request(app)
        .get('/warp-routes')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual({});
    });

    it('should return 400 for invalid query parameters', async () => {
      // WarpRouteFilterSchema is strict - it rejects extra params
      const response = await request(app)
        .get('/warp-routes')
        .query({ invalidParam: 'invalid' })
        .expect(AppConstants.HTTP_STATUS_BAD_REQUEST);

      expect(response.body.message).toContain(
        'Validation error in query parameters',
      );
      expect(mockRootService.getWarpRoutes.called).toBe(false);
    });

    it('should accept valid query parameters only', async () => {
      // Test that only valid schema fields are accepted
      mockRootService.getWarpRoutes.resolves(mockWarpRouteMap);

      const response = await request(app)
        .get('/warp-routes')
        .query({ symbol: 'ETH', label: 'test' })
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).toEqual(mockWarpRouteMap);
      expect(mockRootService.getWarpRoutes.calledOnce).toBe(true);
    });

    it('should handle service errors', async () => {
      mockRootService.getWarpRoutes.rejects(
        new Error('Warp routes fetch failed'),
      );

      const response = await request(app)
        .get('/warp-routes')
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).toContain('Warp routes fetch failed');
    });

    it('should handle multiple filter parameters', async () => {
      const multipleFilters = {
        symbol: 'USDC',
        label: 'stablecoin',
      };

      mockRootService.getWarpRoutes.resolves(mockWarpRouteMap);

      await request(app)
        .get('/warp-routes')
        .query(multipleFilters)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(mockRootService.getWarpRoutes.calledWith(multipleFilters)).toBe(
        true,
      );
    });
  });

  describe('health endpoints', () => {
    // These are typically defined at the server level, but testing here for completeness
    it('should return 404 for undefined routes', async () => {
      await request(app).get('/nonexistent-endpoint').expect(404);
    });
  });

  describe('response headers', () => {
    it('should set correct content-type for JSON responses', async () => {
      mockRootService.getChains.resolves(mockChains);

      await request(app)
        .get('/chains')
        .expect('Content-Type', /json/)
        .expect(AppConstants.HTTP_STATUS_OK);
    });
  });
});
