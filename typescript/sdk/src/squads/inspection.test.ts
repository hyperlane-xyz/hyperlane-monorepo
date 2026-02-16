import { expect } from 'chai';

import {
  inspectArrayValue,
  inspectBufferValue,
  inspectInstanceOf,
  inspectPropertyValue,
  inspectPromiseLikeThenValue,
} from './inspection.js';

describe('squads inspection helpers', () => {
  describe(inspectArrayValue.name, () => {
    it('distinguishes arrays from non-arrays without read failures', () => {
      expect(inspectArrayValue([])).to.deep.equal({
        isArray: true,
        readFailed: false,
      });
      expect(inspectArrayValue({})).to.deep.equal({
        isArray: false,
        readFailed: false,
      });
      expect(inspectArrayValue(null)).to.deep.equal({
        isArray: false,
        readFailed: false,
      });
    });

    it('returns readFailed when array inspection throws', () => {
      const { proxy: revokedValue, revoke } = Proxy.revocable({}, {});
      revoke();

      expect(inspectArrayValue(revokedValue)).to.deep.equal({
        isArray: false,
        readFailed: true,
      });
    });
  });

  describe(inspectPromiseLikeThenValue.name, () => {
    it('returns undefined then/readError for non-object and null values', () => {
      expect(inspectPromiseLikeThenValue(undefined)).to.deep.equal({
        thenValue: undefined,
        readError: undefined,
      });
      expect(inspectPromiseLikeThenValue(null)).to.deep.equal({
        thenValue: undefined,
        readError: undefined,
      });
      expect(inspectPromiseLikeThenValue('value')).to.deep.equal({
        thenValue: undefined,
        readError: undefined,
      });
    });

    it('returns thenValue for readable object and function inputs', () => {
      const objectThen = () => undefined;
      const functionThen = () => undefined;
      const functionValue = Object.assign(() => undefined, {
        then: functionThen,
      });

      expect(inspectPromiseLikeThenValue({ then: objectThen })).to.deep.equal({
        thenValue: objectThen,
        readError: undefined,
      });
      expect(inspectPromiseLikeThenValue(functionValue)).to.deep.equal({
        thenValue: functionThen,
        readError: undefined,
      });
    });

    it('captures read errors from throwing object and function then accessors', () => {
      const objectValue = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw new Error('object then unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const functionValue = new Proxy(() => undefined, {
        get(target, property, receiver) {
          if (property === 'then') {
            throw new Error('function then unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const objectInspection = inspectPromiseLikeThenValue(objectValue);
      expect(objectInspection.thenValue).to.equal(undefined);
      expect(objectInspection.readError).to.be.instanceOf(Error);
      expect((objectInspection.readError as Error).message).to.equal(
        'object then unavailable',
      );

      const functionInspection = inspectPromiseLikeThenValue(functionValue);
      expect(functionInspection.thenValue).to.equal(undefined);
      expect(functionInspection.readError).to.be.instanceOf(Error);
      expect((functionInspection.readError as Error).message).to.equal(
        'function then unavailable',
      );
    });

    it('preserves opaque read errors from then accessors', () => {
      const opaqueError = { source: 'then-getter' };
      const value = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'then') {
              throw opaqueError;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(inspectPromiseLikeThenValue(value)).to.deep.equal({
        thenValue: undefined,
        readError: opaqueError,
      });
    });
  });

  describe(inspectPropertyValue.name, () => {
    it('returns undefined without readError for non-object values', () => {
      expect(inspectPropertyValue(undefined, 'foo')).to.deep.equal({
        propertyValue: undefined,
        readError: undefined,
      });
      expect(inspectPropertyValue(null, 'foo')).to.deep.equal({
        propertyValue: undefined,
        readError: undefined,
      });
      expect(inspectPropertyValue('value', 'foo')).to.deep.equal({
        propertyValue: undefined,
        readError: undefined,
      });
    });

    it('returns property values for readable object and function inputs', () => {
      const functionProperty = () => undefined;
      const functionValue = Object.assign(() => undefined, {
        foo: functionProperty,
      });
      const symbolKey = Symbol('symbol-key');

      expect(inspectPropertyValue({ foo: 'bar' }, 'foo')).to.deep.equal({
        propertyValue: 'bar',
        readError: undefined,
      });
      expect(inspectPropertyValue(functionValue, 'foo')).to.deep.equal({
        propertyValue: functionProperty,
        readError: undefined,
      });
      expect(
        inspectPropertyValue(
          {
            [symbolKey]: 123,
          },
          symbolKey,
        ),
      ).to.deep.equal({
        propertyValue: 123,
        readError: undefined,
      });
    });

    it('captures read errors from throwing object and function accessors', () => {
      const objectValue = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'foo') {
              throw new Error('object property unavailable');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const functionValue = new Proxy(() => undefined, {
        get(target, property, receiver) {
          if (property === 'foo') {
            throw new Error('function property unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const objectInspection = inspectPropertyValue(objectValue, 'foo');
      expect(objectInspection.propertyValue).to.equal(undefined);
      expect(objectInspection.readError).to.be.instanceOf(Error);
      expect((objectInspection.readError as Error).message).to.equal(
        'object property unavailable',
      );

      const functionInspection = inspectPropertyValue(functionValue, 'foo');
      expect(functionInspection.propertyValue).to.equal(undefined);
      expect(functionInspection.readError).to.be.instanceOf(Error);
      expect((functionInspection.readError as Error).message).to.equal(
        'function property unavailable',
      );
    });

    it('preserves opaque read errors from property accessors', () => {
      const opaqueError = { source: 'property-getter' };
      const value = new Proxy(
        {},
        {
          get(target, property, receiver) {
            if (property === 'foo') {
              throw opaqueError;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      expect(inspectPropertyValue(value, 'foo')).to.deep.equal({
        propertyValue: undefined,
        readError: opaqueError,
      });
    });
  });

  describe(inspectBufferValue.name, () => {
    it('returns buffer detection result when Buffer.isBuffer is readable', () => {
      expect(inspectBufferValue(Buffer.from([1, 2, 3]))).to.deep.equal({
        isBuffer: true,
        readFailed: false,
      });
      expect(inspectBufferValue(new Uint8Array([1, 2, 3]))).to.deep.equal({
        isBuffer: false,
        readFailed: false,
      });
    });

    it('returns readFailed when Buffer.isBuffer throws', () => {
      const originalIsBuffer = Buffer.isBuffer;
      const throwingIsBuffer = (() => {
        throw new Error('buffer inspection unavailable');
      }) as unknown as typeof Buffer.isBuffer;

      (Buffer as unknown as { isBuffer: typeof Buffer.isBuffer }).isBuffer =
        throwingIsBuffer;
      try {
        expect(inspectBufferValue(Buffer.from([1]))).to.deep.equal({
          isBuffer: false,
          readFailed: true,
        });
      } finally {
        (Buffer as unknown as { isBuffer: typeof Buffer.isBuffer }).isBuffer =
          originalIsBuffer;
      }
    });
  });

  describe(inspectInstanceOf.name, () => {
    it('returns match results when instanceof evaluation is readable', () => {
      expect(inspectInstanceOf(new Error('boom'), Error)).to.deep.equal({
        matches: true,
        readFailed: false,
      });
      expect(inspectInstanceOf({}, Error)).to.deep.equal({
        matches: false,
        readFailed: false,
      });
    });

    it('returns readFailed when instanceof evaluation throws', () => {
      class ThrowingInstanceof {
        static [Symbol.hasInstance](_value: unknown): boolean {
          throw new Error('instanceof unavailable');
        }
      }

      expect(
        inspectInstanceOf(
          {},
          ThrowingInstanceof as unknown as abstract new (
            ...args: never[]
          ) => unknown,
        ),
      ).to.deep.equal({
        matches: false,
        readFailed: true,
      });
    });
  });
});
