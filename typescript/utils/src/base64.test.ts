import { expect } from 'chai';
import Sinon from 'sinon';

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
      expect(result).to.be.a('string');
      expect(result).to.equal(btoa(JSON.stringify(data)));
    });

    it('should return undefined for null or undefined input', () => {
      expect(toBase64(null)).to.be.undefined;
      expect(toBase64(undefined)).to.be.undefined;
    });

    it('should log an error for invalid input', () => {
      toBase64(null);
      expect(loggerStub.calledOnce).to.be.true;
      expect(
        loggerStub.calledWith(
          'Unable to serialize + encode data to base64',
          null,
        ),
      ).to.be.true;
    });
  });

  describe('fromBase64', () => {
    it('should decode a valid base64 string to an object', () => {
      const data = { key: 'value' };
      const base64String = btoa(JSON.stringify(data));
      const result = fromBase64(base64String);
      expect(result).to.deep.equal(data);
    });

    it('should return undefined for null or undefined input', () => {
      expect(fromBase64(null as any)).to.be.undefined;
      expect(fromBase64(undefined as any)).to.be.undefined;
    });

    it('should handle array input and decode the first element', () => {
      const data = { key: 'value' };
      const base64String = btoa(JSON.stringify(data));
      const result = fromBase64([base64String, 'anotherString']);
      expect(result).to.deep.equal(data);
    });

    it('should log an error for invalid base64 input', () => {
      fromBase64('invalidBase64');
      expect(loggerStub.calledOnce).to.be.true;
      expect(
        loggerStub.calledWith(
          'Unable to decode + deserialize data from base64',
          'invalidBase64',
        ),
      ).to.be.true;
    });
  });
});
