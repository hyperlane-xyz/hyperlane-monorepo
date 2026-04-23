import Sinon from 'sinon';
import { expect } from 'vitest';

import { fromBase64, toBase64 } from './base64.js';
import { rootLogger } from './logging.js';

describe('Base64 Utility Functions', () => {
  let loggerStub: sinon.SinonStub;

  beforeEach(() => {
    loggerStub = Sinon.stub(rootLogger, 'error');
  });

  afterEach(() => {
    loggerStub.restore();
  });

  describe('toBase64', () => {
    it('should encode a valid object to a base64 string', () => {
      const data = { key: 'value' };
      const result = toBase64(data);
      expect(typeof result).toBe('string');
      expect(result).toBe(btoa(JSON.stringify(data)));
    });

    it('should return undefined for null or undefined input', () => {
      expect(toBase64(null)).toBeUndefined();
      expect(toBase64(undefined)).toBeUndefined();
    });

    it('should log an error for invalid input', () => {
      toBase64(null);
      expect(loggerStub.calledOnce).toBe(true);
      expect(
        loggerStub.calledWith(
          'Unable to serialize + encode data to base64',
          null,
        ),
      ).toBe(true);
    });
  });

  describe('fromBase64', () => {
    it('should decode a valid base64 string to an object', () => {
      const data = { key: 'value' };
      const base64String = btoa(JSON.stringify(data));
      const result = fromBase64(base64String);
      expect(result).toEqual(data);
    });

    it('should return undefined for null or undefined input', () => {
      expect(fromBase64(null as any)).toBeUndefined();
      expect(fromBase64(undefined as any)).toBeUndefined();
    });

    it('should handle array input and decode the first element', () => {
      const data = { key: 'value' };
      const base64String = btoa(JSON.stringify(data));
      const result = fromBase64([base64String, 'anotherString']);
      expect(result).toEqual(data);
    });

    it('should log an error for invalid base64 input', () => {
      fromBase64('invalidBase64');
      expect(loggerStub.calledOnce).toBe(true);
      expect(
        loggerStub.calledWith(
          'Unable to decode + deserialize data from base64',
          'invalidBase64',
        ),
      ).toBe(true);
    });
  });
});
