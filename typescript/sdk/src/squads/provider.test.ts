import { expect } from 'chai';
import { Connection } from '@solana/web3.js';

import { toSquadsProvider } from './provider.js';

function expectInvalidProvider(
  provider: unknown,
  getAccountInfoType: string,
  providerType: string,
) {
  expect(() => toSquadsProvider(provider)).to.throw(
    `Invalid Solana provider: expected getAccountInfo function, got ${getAccountInfoType} (provider: ${providerType})`,
  );
}

function expectInvalidProviderContainer(
  provider: unknown,
  providerType: string,
) {
  expect(() => toSquadsProvider(provider)).to.throw(
    `Invalid Solana provider: expected object, got ${providerType}`,
  );
}

function createGetterBackedProvider(getGetAccountInfo: () => unknown): unknown {
  return Object.create(null, {
    getAccountInfo: {
      get: getGetAccountInfo,
      enumerable: true,
    },
  });
}

describe('squads provider bridge', () => {
  it('returns the same provider for valid solana connection', () => {
    const provider = new Connection('http://localhost:8899');
    expect(toSquadsProvider(provider)).to.equal(provider);
  });

  it('accepts provider-like objects with callable getAccountInfo', () => {
    const providerLike = {
      getAccountInfo: async () => null,
    };

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
  });

  it('accepts provider-like objects inheriting callable getAccountInfo', () => {
    const providerPrototype = {
      getAccountInfo: async () => null,
    };
    const providerLike = Object.create(providerPrototype);

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
  });

  it('accepts null-prototype provider-like objects with callable getAccountInfo', () => {
    const providerLike = Object.assign(Object.create(null), {
      getAccountInfo: async () => null,
    });

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
  });

  it('reads getAccountInfo once during provider validation', () => {
    let getAccountInfoReadCount = 0;
    const providerLike = createGetterBackedProvider(() => {
      getAccountInfoReadCount += 1;
      return async () => null;
    });

    expect(toSquadsProvider(providerLike)).to.equal(providerLike);
    expect(getAccountInfoReadCount).to.equal(1);
  });

  it('rejects promise-like providers before getAccountInfo validation', () => {
    const providerLike = {
      getAccountInfo: async () => null,
      then: () => undefined,
    };

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: expected synchronous provider, got promise-like value (provider: object)',
    );
  });

  it('rejects Promise provider values before getAccountInfo validation', () => {
    expect(() =>
      toSquadsProvider(
        Promise.resolve({
          getAccountInfo: async () => null,
        }),
      ),
    ).to.throw(
      'Invalid Solana provider: expected synchronous provider, got promise-like value (provider: object)',
    );
  });

  it('fails with stable malformed-provider error when then accessor throws', () => {
    const providerLike = new Proxy(
      {
        getAccountInfo: async () => null,
      },
      {
        get(target, property, receiver) {
          if (property === 'then') {
            throw new Error('then unavailable');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to inspect promise-like then (then unavailable)',
    );
  });

  it('uses placeholder when then accessor throws generic-object Error messages', () => {
    const providerLike = new Proxy(
      {
        getAccountInfo: async () => null,
      },
      {
        get(target, property, receiver) {
          if (property === 'then') {
            throw new Error('[object Object]');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to inspect promise-like then ([unstringifiable error])',
    );
  });

  it('uses placeholder when then accessor throws blank Error messages', () => {
    const providerLike = new Proxy(
      {
        getAccountInfo: async () => null,
      },
      {
        get(target, property, receiver) {
          if (property === 'then') {
            throw new Error('   ');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to inspect promise-like then ([unstringifiable error])',
    );
  });

  it('uses placeholder when then accessor throws bare Error labels', () => {
    const providerLike = new Proxy(
      {
        getAccountInfo: async () => null,
      },
      {
        get(target, property, receiver) {
          if (property === 'then') {
            throw new Error('Error:');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to inspect promise-like then ([unstringifiable error])',
    );
  });

  it('fails with stable malformed-provider error when getAccountInfo getter throws', () => {
    const providerLike = createGetterBackedProvider(() => {
      throw new Error('getter failure');
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to read getAccountInfo (getter failure)',
    );
  });

  it('fails with stable malformed-provider error when proxy get trap throws', () => {
    const providerLike = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'getAccountInfo') {
            throw new Error('proxy getter failure');
          }
          return undefined;
        },
      },
    );

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to read getAccountInfo (proxy getter failure)',
    );
  });

  it('uses placeholder when getAccountInfo getter throws generic-object Error messages', () => {
    const providerLike = createGetterBackedProvider(() => {
      throw new Error('[object Object]');
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to read getAccountInfo ([unstringifiable error])',
    );
  });

  it('uses placeholder when getAccountInfo getter throws blank Error messages', () => {
    const providerLike = createGetterBackedProvider(() => {
      throw new Error('   ');
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to read getAccountInfo ([unstringifiable error])',
    );
  });

  it('uses placeholder when getAccountInfo getter throws bare Error labels', () => {
    const providerLike = createGetterBackedProvider(() => {
      throw new Error('Error:');
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: failed to read getAccountInfo ([unstringifiable error])',
    );
  });

  it('fails with stable malformed-provider error when provider array inspection throws', () => {
    const { proxy: providerLike, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: expected object, got [unreadable value type]',
    );
  });

  it('reads malformed getter-backed getAccountInfo once during validation', () => {
    let getAccountInfoReadCount = 0;
    const providerLike = createGetterBackedProvider(() => {
      getAccountInfoReadCount += 1;
      return 'not-a-function';
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got string (provider: object)',
    );
    expect(getAccountInfoReadCount).to.equal(1);
  });

  it('reads undefined getter-backed getAccountInfo once during validation', () => {
    let getAccountInfoReadCount = 0;
    const providerLike = createGetterBackedProvider(() => {
      getAccountInfoReadCount += 1;
      return undefined;
    });

    expect(() => toSquadsProvider(providerLike)).to.throw(
      'Invalid Solana provider: expected getAccountInfo function, got undefined (provider: object)',
    );
    expect(getAccountInfoReadCount).to.equal(1);
  });

  const invalidGetAccountInfoCases: Array<{
    title: string;
    provider: unknown;
    getAccountInfoType: string;
  }> = [
    {
      title: 'throws for malformed provider values',
      provider: {},
      getAccountInfoType: 'undefined',
    },
    {
      title: 'throws when getAccountInfo exists but is not callable',
      provider: { getAccountInfo: 'not-a-function' },
      getAccountInfoType: 'string',
    },
    {
      title: 'throws when inherited getAccountInfo is not callable',
      provider: Object.create({ getAccountInfo: 'not-a-function' }),
      getAccountInfoType: 'string',
    },
    {
      title: 'labels array getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: [] },
      getAccountInfoType: 'array',
    },
    {
      title: 'labels null getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: null },
      getAccountInfoType: 'null',
    },
    {
      title:
        'labels boolean getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: false },
      getAccountInfoType: 'boolean',
    },
    {
      title: 'labels object getAccountInfo values in malformed provider errors',
      provider: { getAccountInfo: {} },
      getAccountInfoType: 'object',
    },
  ];

  for (const {
    title,
    provider,
    getAccountInfoType,
  } of invalidGetAccountInfoCases) {
    it(title, () => {
      expectInvalidProvider(provider, getAccountInfoType, 'object');
    });
  }

  const invalidProviderContainerCases: Array<{
    title: string;
    provider: unknown;
    providerType: string;
  }> = [
    {
      title: 'throws for null malformed provider values',
      provider: null,
      providerType: 'null',
    },
    {
      title: 'throws for undefined malformed provider values',
      provider: undefined,
      providerType: 'undefined',
    },
    {
      title: 'labels array provider containers in malformed provider errors',
      provider: [],
      providerType: 'array',
    },
    {
      title: 'labels numeric provider containers in malformed provider errors',
      provider: 1,
      providerType: 'number',
    },
    {
      title: 'labels string provider containers in malformed provider errors',
      provider: 'invalid-provider',
      providerType: 'string',
    },
    {
      title: 'labels boolean provider containers in malformed provider errors',
      provider: false,
      providerType: 'boolean',
    },
    {
      title: 'labels bigint provider containers in malformed provider errors',
      provider: 1n,
      providerType: 'bigint',
    },
    {
      title: 'labels symbol provider containers in malformed provider errors',
      provider: Symbol('invalid-provider'),
      providerType: 'symbol',
    },
    {
      title: 'labels function provider containers in malformed provider errors',
      provider: () => undefined,
      providerType: 'function',
    },
  ];

  for (const {
    title,
    provider,
    providerType,
  } of invalidProviderContainerCases) {
    it(title, () => {
      expectInvalidProviderContainer(provider, providerType);
    });
  }
});
