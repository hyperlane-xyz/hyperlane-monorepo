import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import express, { Express } from 'express';
import { pino } from 'pino';
import sinon from 'sinon';
import request from 'supertest';

import { AppConstants } from '../../src/constants/AppConstants.js';
import { NotFoundError } from '../../src/errors/ApiError.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createWarpRouter } from '../../src/routes/warp.js';
import { WarpService } from '../../src/services/warpService.js';
import { mockWarpRouteDeploys, mockWarpRoutes } from '../utils/mockData.js';

chaiUse(chaiAsPromised);

describe('Warp Routes', () => {
  let app: Express;
  let mockWarpService: sinon.SinonStubbedInstance<WarpService>;

  const mockWarpRoute = mockWarpRoutes[0];
  const mockWarpRouteDeploy = mockWarpRouteDeploys[0];

  beforeEach(() => {
    // Create stubbed warp service
    mockWarpService = sinon.createStubInstance(WarpService);
    const mockLogger = pino({ level: 'silent' });

    // Create Express app with warp routes
    app = express();
    app.use(express.json());
    app.use('/warp-route', createWarpRouter(mockWarpService));
    app.use(createErrorHandler(mockLogger));
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('GET /warp-route/core/:id', () => {
    it('should return warp route when it exists', async () => {
      const warpRouteId = 'test/warp-route';
      mockWarpService.getWarpCoreConfig.resolves(mockWarpRoute);

      const response = await request(app)
        .get(`/warp-route/core/${warpRouteId}`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockWarpRoute);
      expect(mockWarpService.getWarpCoreConfig.calledWith(warpRouteId)).to.be
        .true;
    });

    it('should return 404 when warp route does not exist', async () => {
      const warpRouteId = 'nonexistent/warp-route';
      mockWarpService.getWarpCoreConfig.rejects(
        new NotFoundError('Warp route not found'),
      );

      const response = await request(app)
        .get(`/warp-route/core/${warpRouteId}`)
        .expect(AppConstants.HTTP_STATUS_NOT_FOUND);

      expect(response.body.message).to.include('Warp route not found');
      expect(mockWarpService.getWarpCoreConfig.calledWith(warpRouteId)).to.be
        .true;
    });

    it('should return 500 when service throws unexpected error', async () => {
      const warpRouteId = 'error/warp-route';
      mockWarpService.getWarpCoreConfig.rejects(new Error('Unexpected error'));

      const response = await request(app)
        .get(`/warp-route/core/${warpRouteId}`)
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).to.include('Internal Server Error');
      expect(response.body.message).to.include('Unexpected error');
    });

    it('should return warp core configs when no id is provided', async () => {
      const warpCoreConfig = {
        'test/warp-route': mockWarpRoute,
      };
      mockWarpService.getWarpCoreConfigs.resolves(warpCoreConfig);

      const response = await request(app)
        .get(`/warp-route/core`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(warpCoreConfig);
    });

    it('should handle special characters in warp route ID', async () => {
      const specialId = 'test/warp-route-with-special@chars!';
      mockWarpService.getWarpCoreConfig.resolves(mockWarpRoute);

      const response = await request(app)
        .get(`/warp-route/core/${encodeURIComponent(specialId)}`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockWarpRoute);
      expect(mockWarpService.getWarpCoreConfig.calledWith(specialId)).to.be
        .true;
    });

    it('should handle service returning null gracefully', async () => {
      const warpRouteId = 'null/return';
      // Service should throw NotFoundError, but test edge case
      mockWarpService.getWarpCoreConfig.resolves(null as any);

      const response = await request(app)
        .get(`/warp-route/core/${warpRouteId}`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.be.null;
    });

    it('should preserve response headers', async () => {
      const warpRouteId = 'test-headers/warp-route';
      mockWarpService.getWarpCoreConfig.resolves(mockWarpRoute);

      const response = await request(app)
        .get(`/warp-route/core/${warpRouteId}`)
        .expect('Content-Type', /json/)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockWarpRoute);
    });
  });

  describe('GET /warp-route/deploy/:id', () => {
    it('should return warp route when it exists', async () => {
      const warpRouteId = 'test/warp-route';
      mockWarpService.getWarpDeployConfig.resolves(mockWarpRouteDeploy);

      const response = await request(app)
        .get(`/warp-route/deploy/${warpRouteId}`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockWarpRouteDeploy);
      expect(mockWarpService.getWarpDeployConfig.calledWith(warpRouteId)).to.be
        .true;
    });
  });
});
