import { expect } from 'chai';

import {
  cloneOwnEnumerableObject,
  getOwnObjectField,
  hasOwnObjectField,
} from '../../submitters/object.js';

describe('submitter own-object helpers', () => {
  it('getOwnObjectField returns own field values', () => {
    const value = { submitter: { type: 'jsonRpc' } };
    expect(getOwnObjectField(value, 'submitter')).to.deep.equal({
      type: 'jsonRpc',
    });
  });

  it('getOwnObjectField ignores inherited fields', () => {
    const parent = { submitter: { type: 'jsonRpc' } };
    const child = Object.create(parent);
    expect(getOwnObjectField(child, 'submitter')).to.equal(undefined);
  });

  it('getOwnObjectField returns undefined when own getter throws', () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, 'submitter', {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(getOwnObjectField(value, 'submitter')).to.equal(undefined);
  });

  it('getOwnObjectField returns undefined for disallowed own fields', () => {
    const value = { submitter: { type: 'jsonRpc' } };
    expect(
      getOwnObjectField(value, 'submitter', {
        disallowedFields: new Set(['submitter']),
      }),
    ).to.equal(undefined);
  });

  it('hasOwnObjectField returns false when hasOwnProperty throws', () => {
    const throwingProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    expect(hasOwnObjectField(throwingProxy, 'submitter')).to.equal(false);
  });

  it('cloneOwnEnumerableObject returns null for non-objects', () => {
    expect(cloneOwnEnumerableObject(null)).to.equal(null);
    expect(cloneOwnEnumerableObject(undefined)).to.equal(null);
    expect(cloneOwnEnumerableObject('foo')).to.equal(null);
  });

  it('cloneOwnEnumerableObject clones own enumerable fields only', () => {
    const source = Object.create({ inherited: 2 }) as Record<string, unknown>;
    source.own = 1;

    const cloned = cloneOwnEnumerableObject(source);
    expect(cloned).to.not.equal(null);
    expect(cloned).to.deep.equal({ own: 1 });
    expect(Object.getPrototypeOf(cloned)).to.equal(null);
  });

  it('cloneOwnEnumerableObject returns null when key enumeration throws', () => {
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(cloneOwnEnumerableObject(throwingProxy)).to.equal(null);
  });

  it('cloneOwnEnumerableObject omits disallowed own fields', () => {
    const source = {
      submitter: { type: 'jsonRpc' },
      keep: 1,
    };

    const cloned = cloneOwnEnumerableObject(source, {
      disallowedFields: new Set(['submitter']),
    });
    expect(cloned).to.deep.equal({ keep: 1 });
  });
});
