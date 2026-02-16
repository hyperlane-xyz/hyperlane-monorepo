import { expect } from 'chai';

import {
  inspectArrayValue,
  inspectBufferValue,
  inspectInstanceOf,
  inspectObjectEntries,
  inspectObjectKeys,
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

  describe(inspectObjectEntries.name, () => {
    it('returns entries for object and function values', () => {
      const functionValue = Object.assign(() => undefined, {
        a: 1,
      });
      expect(inspectObjectEntries({ a: 1, b: 2 })).to.deep.equal({
        entries: [
          ['a', 1],
          ['b', 2],
        ],
        readError: undefined,
      });
      expect(inspectObjectEntries(functionValue)).to.deep.equal({
        entries: [['a', 1]],
        readError: undefined,
      });
      expect(inspectObjectEntries(null)).to.deep.equal({
        entries: [],
        readError: undefined,
      });
      expect(inspectObjectEntries('value')).to.deep.equal({
        entries: [],
        readError: undefined,
      });
    });

    it('captures read errors when entries access throws', () => {
      const { proxy: revokedValue, revoke } = Proxy.revocable({}, {});
      revoke();
      const inspection = inspectObjectEntries(revokedValue);
      expect(inspection.entries).to.deep.equal([]);
      expect(inspection.readError).to.be.instanceOf(TypeError);
    });

    it('preserves opaque read errors from entry access', () => {
      const opaqueError = { source: 'entries-ownKeys' };
      const value = new Proxy(
        {},
        {
          ownKeys() {
            throw opaqueError;
          },
        },
      );

      expect(inspectObjectEntries(value)).to.deep.equal({
        entries: [],
        readError: opaqueError,
      });
    });
  });

  describe(inspectObjectKeys.name, () => {
    it('returns keys for object and function values', () => {
      const functionValue = Object.assign(() => undefined, {
        a: 1,
      });
      expect(inspectObjectKeys({ a: 1, b: 2 })).to.deep.equal({
        keys: ['a', 'b'],
        readError: undefined,
      });
      expect(inspectObjectKeys(functionValue)).to.deep.equal({
        keys: ['a'],
        readError: undefined,
      });
      expect(inspectObjectKeys(null)).to.deep.equal({
        keys: [],
        readError: undefined,
      });
      expect(inspectObjectKeys('value')).to.deep.equal({
        keys: [],
        readError: undefined,
      });
    });

    it('captures read errors when key access throws', () => {
      const { proxy: revokedValue, revoke } = Proxy.revocable({}, {});
      revoke();
      const inspection = inspectObjectKeys(revokedValue);
      expect(inspection.keys).to.deep.equal([]);
      expect(inspection.readError).to.be.instanceOf(TypeError);
    });

    it('preserves opaque read errors from key access', () => {
      const opaqueError = { source: 'keys-ownKeys' };
      const value = new Proxy(
        {},
        {
          ownKeys() {
            throw opaqueError;
          },
        },
      );

      expect(inspectObjectKeys(value)).to.deep.equal({
        keys: [],
        readError: opaqueError,
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
      const throwingIsBuffer: typeof Buffer.isBuffer = (
        _value: unknown,
      ): _value is Buffer<ArrayBufferLike> => {
        throw new Error('buffer inspection unavailable');
      };

      Object.defineProperty(Buffer, 'isBuffer', {
        value: throwingIsBuffer,
        writable: true,
        configurable: true,
      });
      try {
        expect(inspectBufferValue(Buffer.from([1]))).to.deep.equal({
          isBuffer: false,
          readFailed: true,
        });
      } finally {
        Object.defineProperty(Buffer, 'isBuffer', {
          value: originalIsBuffer,
          writable: true,
          configurable: true,
        });
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
