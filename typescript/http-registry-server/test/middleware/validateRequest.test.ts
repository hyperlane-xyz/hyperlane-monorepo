import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Request, Response } from 'express';
import sinon from 'sinon';
import { z } from 'zod';

import { AppConstants } from '../../src/constants/AppConstants.js';
import { ApiError } from '../../src/errors/ApiError.js';
import {
  validateBody,
  validateQueryParam,
  validateQueryParams,
  validateRequestParam,
} from '../../src/middleware/validateRequest.js';

chaiUse(chaiAsPromised);

describe('validateRequest middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: sinon.SinonSpy;

  beforeEach(() => {
    req = {
      params: {},
      query: {},
      body: {},
    };
    res = {};
    next = sinon.spy();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('validateQueryParams', () => {
    const testSchema = z.object({
      limit: z
        .string()
        .transform(Number)
        .refine((n) => n > 0, 'Must be positive'),
      page: z.string().optional(),
    });

    it('should pass validation with valid query parameters', () => {
      req.query = { limit: '10', page: '1' };

      const middleware = validateQueryParams(testSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      expect(next.calledWith()).to.be.true; // Called without error
      expect(req.query).to.deep.equal({ limit: 10, page: '1' }); // Transformed
    });

    it('should fail validation with invalid query parameters', () => {
      req.query = { limit: '0' }; // Invalid: not positive

      const middleware = validateQueryParams(testSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.status).to.equal(AppConstants.HTTP_STATUS_BAD_REQUEST);
      expect(error.message).to.include('Validation error in query parameters');
      expect(error.message).to.include('Must be positive');
    });

    it('should handle missing required parameters', () => {
      req.query = {}; // Missing required 'limit'

      const middleware = validateQueryParams(testSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.message).to.include('Required');
    });
  });

  describe('validateRequestParam', () => {
    const stringSchema = z.string().min(1, 'Must not be empty');

    it('should pass validation with valid parameter', () => {
      req.params = { id: 'test-id' };

      const middleware = validateRequestParam('id', stringSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      expect(next.calledWith()).to.be.true;
      expect(req.params!.id).to.equal('test-id');
    });

    it('should fail validation with invalid parameter', () => {
      req.params = { id: '' }; // Invalid: empty string

      const middleware = validateRequestParam('id', stringSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.status).to.equal(AppConstants.HTTP_STATUS_BAD_REQUEST);
      expect(error.message).to.include("Validation error for param 'id'");
      expect(error.message).to.include('Must not be empty');
    });

    it('should handle missing parameter', () => {
      req.params = {}; // Missing 'id' parameter

      const middleware = validateRequestParam('id', stringSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.message).to.include('Required');
    });
  });

  describe('validateBody', () => {
    const bodySchema = z.object({
      name: z.string().min(1),
      chainId: z.number().positive(),
    });

    it('should pass validation with valid body', () => {
      req.body = { name: 'test-chain', chainId: 1 };

      const middleware = validateBody(bodySchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      expect(next.calledWith()).to.be.true;
      expect(req.body).to.deep.equal({ name: 'test-chain', chainId: 1 });
    });

    it('should fail validation with invalid body', () => {
      req.body = { name: '', chainId: -1 }; // Invalid values

      const middleware = validateBody(bodySchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.status).to.equal(AppConstants.HTTP_STATUS_BAD_REQUEST);
      expect(error.message).to.include('Validation error in body');
    });

    it('should transform valid body data', () => {
      const transformSchema = z.object({
        count: z.string().transform(Number),
      });
      req.body = { count: '42' };

      const middleware = validateBody(transformSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      expect(next.calledWith()).to.be.true;
      expect(req.body).to.deep.equal({ count: 42 }); // Transformed to number
    });
  });

  describe('validateQueryParam', () => {
    const numberSchema = z
      .string()
      .transform(Number)
      .refine((n) => n >= 0);

    it('should pass validation with valid single query parameter', () => {
      req.query = { offset: '5' };

      const middleware = validateQueryParam('offset', numberSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      expect(next.calledWith()).to.be.true;
      expect(req.query!.offset).to.equal(5); // Transformed to number
    });

    it('should fail validation with invalid query parameter', () => {
      req.query = { offset: 'invalid' };

      const middleware = validateQueryParam('offset', numberSchema);
      middleware(req as Request, res as Response, next);

      expect(next.calledOnce).to.be.true;
      const error = next.getCall(0).args[0];
      expect(error).to.be.instanceOf(ApiError);
      expect(error.status).to.equal(AppConstants.HTTP_STATUS_BAD_REQUEST);
      expect(error.message).to.include('Validation error in query');
    });
  });
});
