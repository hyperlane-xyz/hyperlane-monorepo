import { use as chaiUse, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Request } from 'express';
import sinon from 'sinon';

import { AppConstants } from '../../src/constants/AppConstants.js';
import { ApiError, NotFoundError } from '../../src/errors/ApiError.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';

chaiUse(chaiAsPromised);

type MockResponse = {
  headersSent: boolean;
  status: sinon.SinonStub;
  json: sinon.SinonStub;
};

describe('errorHandler middleware', () => {
  let req: Partial<Request>;
  let res: MockResponse;
  let next: sinon.SinonSpy;
  let mockLogger: { error: sinon.SinonSpy };

  beforeEach(() => {
    req = {};
    res = {
      headersSent: false,
      status: sinon.stub().returnsThis(),
      json: sinon.stub().returnsThis(),
    };
    next = sinon.spy();
    mockLogger = {
      error: sinon.spy(),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createErrorHandler', () => {
    it('should handle ApiError correctly', () => {
      const error = new ApiError(
        'Test API error',
        AppConstants.HTTP_STATUS_BAD_REQUEST,
      );
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(mockLogger.error.calledWith({ error }, 'Error handling request'))
        .to.be.true;
      expect(res.status.calledWith(AppConstants.HTTP_STATUS_BAD_REQUEST)).to.be
        .true;
      expect(
        res.json.calledWith({
          message: 'Test API error',
          stack: undefined,
        }),
      ).to.be.true;
      expect(next.called).to.be.false;
    });

    it('should handle NotFoundError correctly', () => {
      const error = new NotFoundError('Test resource');
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(mockLogger.error.calledWith({ error }, 'Error handling request'))
        .to.be.true;
      expect(res.status.calledWith(AppConstants.HTTP_STATUS_NOT_FOUND)).to.be
        .true;
      expect(
        res.json.calledWith({
          message: 'Test resource not found',
          stack: undefined,
        }),
      ).to.be.true;
    });

    it('should convert generic Error to ApiError', () => {
      const error = new Error('Generic error message');
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(mockLogger.error.calledWith({ error }, 'Error handling request'))
        .to.be.true;
      expect(
        res.status.calledWith(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR),
      ).to.be.true;
      expect(
        res.json.calledWith({
          message: 'Internal Server Error: Generic error message',
          stack: error.stack,
        }),
      ).to.be.true;
    });

    it('should handle unknown error types', () => {
      const error = 'string error';
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(mockLogger.error.calledWith({ error }, 'Error handling request'))
        .to.be.true;
      expect(
        res.status.calledWith(AppConstants.HTTP_STATUS_INTERNAL_SERVER_ERROR),
      ).to.be.true;
      expect(
        res.json.calledWith({
          message: 'Internal Server Error: unknown error',
          stack: undefined,
        }),
      ).to.be.true;
    });

    it('should preserve custom ApiError status and stack', () => {
      const customStack = 'Custom stack trace';
      const error = new ApiError('Custom error', 422, customStack);
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(res.status.calledWith(422)).to.be.true;
      expect(
        res.json.calledWith({
          message: 'Custom error',
          stack: customStack,
        }),
      ).to.be.true;
    });

    it('should delegate to default handler if headers already sent', () => {
      res.headersSent = true;
      const error = new ApiError('Test error');
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(next.calledWith(error)).to.be.true;
      expect(res.status.called).to.be.false;
      expect(res.json.called).to.be.false;
    });

    it('should handle Error with stack trace correctly', () => {
      const error = new Error('Error with stack');
      error.stack = 'Mock stack trace\n  at test location';
      const errorHandler = createErrorHandler(mockLogger as any);

      errorHandler(error, req as Request, res as any, next);

      expect(
        res.json.calledWith({
          message: 'Internal Server Error: Error with stack',
          stack: 'Mock stack trace\n  at test location',
        }),
      ).to.be.true;
    });
  });
});
