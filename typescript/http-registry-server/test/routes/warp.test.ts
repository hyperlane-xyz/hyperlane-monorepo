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
import {
  mockWarpDeployConfigMap,
  mockWarpRouteDeploys,
  mockWarpRoutes,
} from '../utils/mockData.js';

chaiUse(chaiAsPromised);

describe('Warp Routes', () => {
  let app: Express;
  let appWithWriteMode: Express;
  let mockWarpService: sinon.SinonStubbedInstance<WarpService>;

  const mockWarpRoute = mockWarpRoutes[0];
  const mockWarpRouteDeploy = mockWarpRouteDeploys[0];

  beforeEach(() => {
    // Create stubbed warp service
    mockWarpService = sinon.createStubInstance(WarpService);
    const mockLogger = pino({ level: 'silent' });

    // Create Express app with warp routes (writeMode disabled)
    app = express();
    app.use(express.json());
    app.use('/warp-route', createWarpRouter(mockWarpService));
    app.use(createErrorHandler(mockLogger));

    // Create Express app with writeMode enabled
    appWithWriteMode = express();
    appWithWriteMode.use(express.json());
    appWithWriteMode.use(
      '/warp-route',
      createWarpRouter(mockWarpService, { writeMode: true }),
    );
    appWithWriteMode.use(createErrorHandler(mockLogger));
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

  describe('GET /warp-route/deploy', () => {
    it('should return all warp deploy configs', async () => {
      mockWarpService.getWarpDeployConfigs.resolves(mockWarpDeployConfigMap);

      const response = await request(app)
        .get('/warp-route/deploy')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockWarpDeployConfigMap);
      expect(mockWarpService.getWarpDeployConfigs.calledOnce).to.be.true;
    });

    it('should pass filter params to service', async () => {
      mockWarpService.getWarpDeployConfigs.resolves({});

      await request(app)
        .get('/warp-route/deploy?symbol=TEST')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(
        mockWarpService.getWarpDeployConfigs.calledWith({ symbol: 'TEST' }),
      ).to.be.true;
    });
  });

  describe('POST /warp-route (addWarpRoute)', () => {
    it('should return 405 when writeMode is disabled', async () => {
      const response = await request(app)
        .post('/warp-route')
        .send({ config: mockWarpRoute })
        .expect(AppConstants.HTTP_STATUS_METHOD_NOT_ALLOWED);

      expect(response.body.message).to.include('Write operations are disabled');
      expect(mockWarpService.addWarpRoute.called).to.be.false;
    });

    it('should add warp route when writeMode is enabled', async () => {
      mockWarpService.addWarpRoute.resolves();

      await request(appWithWriteMode)
        .post('/warp-route')
        .send({ config: mockWarpRoute })
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);

      expect(mockWarpService.addWarpRoute.calledOnce).to.be.true;
      expect(mockWarpService.addWarpRoute.firstCall.args[0]).to.deep.equal(
        mockWarpRoute,
      );
    });

    it('should pass options to service when provided', async () => {
      mockWarpService.addWarpRoute.resolves();
      const options = { symbol: 'TEST' };

      await request(appWithWriteMode)
        .post('/warp-route')
        .send({ config: mockWarpRoute, options })
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);

      expect(mockWarpService.addWarpRoute.calledOnce).to.be.true;
      expect(mockWarpService.addWarpRoute.firstCall.args[1]).to.deep.equal(
        options,
      );
    });
  });

  describe('POST /warp-route/deploy (addWarpRouteConfig)', () => {
    it('should return 405 when writeMode is disabled', async () => {
      const response = await request(app)
        .post('/warp-route/deploy')
        .send({ config: mockWarpRouteDeploy, options: { symbol: 'TEST' } })
        .expect(AppConstants.HTTP_STATUS_METHOD_NOT_ALLOWED);

      expect(response.body.message).to.include('Write operations are disabled');
      expect(mockWarpService.addWarpRouteConfig.called).to.be.false;
    });

    it('should add warp deploy config when writeMode is enabled', async () => {
      mockWarpService.addWarpRouteConfig.resolves();
      const options = { symbol: 'TEST' };

      await request(appWithWriteMode)
        .post('/warp-route/deploy')
        .send({ config: mockWarpRouteDeploy, options })
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);

      expect(mockWarpService.addWarpRouteConfig.calledOnce).to.be.true;
      expect(
        mockWarpService.addWarpRouteConfig.firstCall.args[0],
      ).to.deep.equal(mockWarpRouteDeploy);
      expect(
        mockWarpService.addWarpRouteConfig.firstCall.args[1],
      ).to.deep.equal(options);
    });

    it('should accept warpRouteId option', async () => {
      mockWarpService.addWarpRouteConfig.resolves();
      const options = { warpRouteId: 'test/route' };

      await request(appWithWriteMode)
        .post('/warp-route/deploy')
        .send({ config: mockWarpRouteDeploy, options })
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);

      expect(
        mockWarpService.addWarpRouteConfig.firstCall.args[1],
      ).to.deep.equal(options);
    });
  });
});
