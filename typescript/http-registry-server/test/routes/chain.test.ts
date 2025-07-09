import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import express, { Express } from 'express';
import { pino } from 'pino';
import sinon from 'sinon';
import request from 'supertest';

import { AppConstants } from '../../src/constants/AppConstants.js';
import { NotFoundError } from '../../src/errors/ApiError.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { createChainRouter } from '../../src/routes/chain.js';
import { ChainService } from '../../src/services/chainService.js';
import {
  MOCK_CHAIN_NAME,
  mockChainAddresses,
  mockChainMetadata,
} from '../utils/mockData.js';

chaiUse(chaiAsPromised);

describe('Chain Routes', () => {
  let app: Express;
  let mockChainService: sinon.SinonStubbedInstance<ChainService>;

  beforeEach(() => {
    // Create stubbed chain service
    mockChainService = sinon.createStubInstance(ChainService);
    const mockLogger = pino({ level: 'silent' });

    // Create Express app with chain routes
    app = express();
    app.use(express.json());
    app.use('/chain', createChainRouter(mockChainService));
    app.use(createErrorHandler(mockLogger));
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('GET /chain/:chain/metadata', () => {
    it('should return chain metadata when it exists', async () => {
      mockChainService.getChainMetadata.resolves(mockChainMetadata);

      const response = await request(app)
        .get(`/chain/${MOCK_CHAIN_NAME}/metadata`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockChainMetadata);
      expect(mockChainService.getChainMetadata.calledWith(MOCK_CHAIN_NAME)).to
        .be.true;
    });

    it('should return 404 when chain metadata does not exist', async () => {
      mockChainService.getChainMetadata.rejects(
        new NotFoundError('Chain metadata not found'),
      );

      const response = await request(app)
        .get('/chain/nonexistent/metadata')
        .expect(AppConstants.HTTP_STATUS_NOT_FOUND);

      expect(response.body.message).to.include('Chain metadata not found');
    });

    it('should return 500 when service throws unexpected error', async () => {
      mockChainService.getChainMetadata.rejects(new Error('Database error'));

      const response = await request(app)
        .get(`/chain/${MOCK_CHAIN_NAME}/metadata`)
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).to.include('Internal Server Error');
      expect(response.body.message).to.include('Database error');
    });

    it('should handle valid chain names', async () => {
      const validChainName = 'testarbitrum123';
      mockChainService.getChainMetadata.resolves(mockChainMetadata);

      await request(app)
        .get(`/chain/${validChainName}/metadata`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(mockChainService.getChainMetadata.calledWith(validChainName)).to.be
        .true;
    });
  });

  describe('POST /chain/:chain', () => {
    it('should update chain successfully', async () => {
      const updateParams = {
        metadata: {
          ...mockChainMetadata,
          displayName: 'Updated Chain',
        },
      };
      mockChainService.updateChain.resolves();

      await request(app)
        .post(`/chain/${MOCK_CHAIN_NAME}`)
        .send(updateParams)
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);

      expect(
        mockChainService.updateChain.calledWith({
          chainName: MOCK_CHAIN_NAME,
          ...updateParams,
        }),
      ).to.be.true;
    });

    it('should return 400 for invalid metadata schema', async () => {
      const invalidMetadata = { invalidField: 'invalid' };

      const response = await request(app)
        .post(`/chain/${MOCK_CHAIN_NAME}`)
        .send(invalidMetadata)
        .expect(AppConstants.HTTP_STATUS_BAD_REQUEST);

      expect(response.body.message).to.include('Validation error in body');
      expect(mockChainService.updateChain.called).to.be.false;
    });

    it('should return 400 for missing request body', async () => {
      const response = await request(app)
        .post(`/chain/${MOCK_CHAIN_NAME}`)
        .expect(AppConstants.HTTP_STATUS_BAD_REQUEST);

      expect(response.body.message).to.include('Validation error in body');
    });

    it('should return 500 when service update fails', async () => {
      const updateParams = {
        metadata: mockChainMetadata,
      };
      mockChainService.updateChain.rejects(new Error('Update failed'));

      const response = await request(app)
        .post(`/chain/${MOCK_CHAIN_NAME}`)
        .send(updateParams)
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).to.include('Update failed');
    });

    it('should handle content-type correctly', async () => {
      const updateParams = {
        metadata: {
          ...mockChainMetadata,
          displayName: 'JSON Test',
        },
      };
      mockChainService.updateChain.resolves();

      await request(app)
        .post(`/chain/${MOCK_CHAIN_NAME}`)
        .set('Content-Type', 'application/json')
        .send(updateParams)
        .expect(AppConstants.HTTP_STATUS_NO_CONTENT);
    });
  });

  describe('GET /chain/:chain/addresses', () => {
    it('should return chain addresses when they exist', async () => {
      mockChainService.getChainAddresses.resolves(mockChainAddresses);

      const response = await request(app)
        .get(`/chain/${MOCK_CHAIN_NAME}/addresses`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(mockChainAddresses);
      expect(mockChainService.getChainAddresses.calledWith(MOCK_CHAIN_NAME)).to
        .be.true;
    });

    it('should return 404 when chain addresses do not exist', async () => {
      mockChainService.getChainAddresses.rejects(
        new NotFoundError('Chain addresses not found'),
      );

      const response = await request(app)
        .get('/chain/nonexistent/addresses')
        .expect(AppConstants.HTTP_STATUS_NOT_FOUND);

      expect(response.body.message).to.include('Chain addresses not found');
    });

    it('should return 500 when service throws unexpected error', async () => {
      mockChainService.getChainAddresses.rejects(new Error('Service error'));

      const response = await request(app)
        .get(`/chain/${MOCK_CHAIN_NAME}/addresses`)
        .expect(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR);

      expect(response.body.message).to.include('Service error');
    });

    it('should handle empty addresses object', async () => {
      const emptyAddresses = {};
      mockChainService.getChainAddresses.resolves(emptyAddresses);

      const response = await request(app)
        .get(`/chain/${MOCK_CHAIN_NAME}/addresses`)
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(response.body).to.deep.equal(emptyAddresses);
    });
  });

  describe('parameter validation', () => {
    it('should accept valid chain names', async () => {
      // Test with a valid chain name
      mockChainService.getChainMetadata.resolves(mockChainMetadata);

      // A valid chain name should work
      await request(app)
        .get('/chain/ethereum/metadata')
        .expect(AppConstants.HTTP_STATUS_OK);

      expect(mockChainService.getChainMetadata.calledWith('ethereum')).to.be
        .true;
    });

    it('should reject invalid chain names', async () => {
      const invalidChainName = 'invalid-chain-name!';
      const response = await request(app)
        .get(`/chain/${invalidChainName}/metadata`)
        .expect(AppConstants.HTTP_STATUS_BAD_REQUEST);

      expect(response.body.message).to.include(
        "Validation error for param 'chain'",
      );
      expect(mockChainService.getChainMetadata.called).to.be.false;
    });
  });
});
