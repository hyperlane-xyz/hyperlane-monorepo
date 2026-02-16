import { expect } from 'chai';

import { TxSubmitterType } from '@hyperlane-xyz/sdk';

import {
  ExtendedChainSubmissionStrategySchema,
  parseExtendedChainSubmissionStrategy,
  parseExtendedSubmissionStrategy,
} from '../../submitters/types.js';

describe('ExtendedChainSubmissionStrategySchema', () => {
  const CHAIN = 'ethereum';
  const ADDRESS_1 = '0x1234567890123456789012345678901234567890';
  const ADDRESS_2 = '0x9876543210987654321098765432109876543210';
  const ADDRESS_3 = '0x1111111111111111111111111111111111111111';

  it('preprocesses submitterOverrides with inferred chain fields', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            safeAddress: ADDRESS_2,
          },
        },
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const chainStrategy = parsed[CHAIN];

    expect(chainStrategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(chainStrategy.submitter.chain).to.equal(CHAIN);

    const override = chainStrategy.submitterOverrides?.[ADDRESS_1] as Extract<
      typeof chainStrategy.submitter,
      { type: TxSubmitterType.GNOSIS_TX_BUILDER }
    >;
    expect(override).to.exist;
    expect(override.type).to.equal(TxSubmitterType.GNOSIS_TX_BUILDER);
    expect(override.chain).to.equal(CHAIN);
    expect(override.version).to.equal('1.0');
  });

  it('preprocesses nested ICA override internal submitter defaults', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN,
            owner: ADDRESS_2,
            internalSubmitter: {
              type: TxSubmitterType.JSON_RPC,
            },
          },
        },
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const override = parsed[CHAIN].submitterOverrides?.[ADDRESS_1] as Extract<
      (typeof parsed)[typeof CHAIN]['submitter'],
      { type: TxSubmitterType.INTERCHAIN_ACCOUNT }
    >;

    expect(override.type).to.equal(TxSubmitterType.INTERCHAIN_ACCOUNT);
    expect(override.destinationChain).to.equal(CHAIN);
    expect(override.internalSubmitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(override.internalSubmitter.chain).to.equal(CHAIN);
  });

  it('ignores inherited root chain entries during preprocessing', () => {
    const inheritedInput = Object.create({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    });

    const parsed = ExtendedChainSubmissionStrategySchema.parse(inheritedInput);

    expect(parsed[CHAIN]).to.equal(undefined);
  });

  it('ignores inherited submitterOverrides during preprocessing', () => {
    const chainStrategy = Object.create({
      submitterOverrides: {
        [ADDRESS_1]: {
          type: TxSubmitterType.GNOSIS_TX_BUILDER,
          safeAddress: ADDRESS_2,
        },
      },
    });
    chainStrategy.submitter = {
      type: TxSubmitterType.JSON_RPC,
    };

    const input = {
      [CHAIN]: chainStrategy,
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    const parsedChainStrategy = parsed[CHAIN];

    expect(parsedChainStrategy.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(parsedChainStrategy.submitter.chain).to.equal(CHAIN);
    expect(parsedChainStrategy.submitterOverrides).to.equal(undefined);
  });

  it('fails when submitter exists only on prototype during preprocessing', () => {
    const input = {
      [CHAIN]: Object.create({
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      }),
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('fails when override submitter exists only on prototype during preprocessing', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: Object.create({
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN,
          }),
        },
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('fails when submitter type exists only on submitter prototype during preprocessing', () => {
    const input = {
      [CHAIN]: {
        submitter: Object.create({
          type: TxSubmitterType.JSON_RPC,
        }),
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('fails when override safeAddress exists only on prototype during preprocessing', () => {
    const overrideSubmitter = Object.create({
      safeAddress: ADDRESS_2,
    });
    overrideSubmitter.type = TxSubmitterType.GNOSIS_TX_BUILDER;

    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: overrideSubmitter,
        },
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });

  it('ignores submitterOverrides when override key enumeration throws during preprocessing', () => {
    const throwingOverrides = new Proxy(
      {
        [ADDRESS_1]: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
      },
      {
        ownKeys: () => {
          throw new Error('boom');
        },
      },
    );
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: throwingOverrides,
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    expect(parsed[CHAIN].submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    expect(parsed[CHAIN].submitterOverrides).to.equal(undefined);
  });

  it('keeps valid overrides when another override getter throws during preprocessing', () => {
    const overrides: Record<string, unknown> = {
      [ADDRESS_1]: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
    };
    Object.defineProperty(overrides, ADDRESS_2, {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });

    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: overrides,
      },
    };

    const parsed = ExtendedChainSubmissionStrategySchema.parse(input);
    expect(parsed[CHAIN].submitterOverrides).to.not.equal(undefined);
    expect(Object.keys(parsed[CHAIN].submitterOverrides ?? {})).to.deep.equal([
      ADDRESS_1,
    ]);
    expect(parsed[CHAIN].submitterOverrides?.[ADDRESS_1]?.type).to.equal(
      TxSubmitterType.JSON_RPC,
    );
    expect(parsed[CHAIN].submitterOverrides?.[ADDRESS_3]).to.equal(undefined);
  });

  it('ignores inherited submitterOverrides during refinement when Object prototype is polluted', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitterOverrides',
    );
    Object.defineProperty(Object.prototype, 'submitterOverrides', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('boom');
          },
        },
      ),
    });

    try {
      const parsed = ExtendedChainSubmissionStrategySchema.parse({
        [CHAIN]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
          },
        },
      });

      expect(parsed[CHAIN].submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect(
        Object.prototype.hasOwnProperty.call(
          parsed[CHAIN],
          'submitterOverrides',
        ),
      ).to.equal(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitterOverrides',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitterOverrides;
      }
    }
  });

  it('fails when ICA override owner and safe address mismatch', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {
          [ADDRESS_1]: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: CHAIN,
            owner: ADDRESS_1,
            destinationChain: CHAIN,
            internalSubmitter: {
              type: TxSubmitterType.GNOSIS_SAFE,
              chain: CHAIN,
              safeAddress: ADDRESS_2,
            },
          },
        },
      },
    };

    const result = ExtendedChainSubmissionStrategySchema.safeParse(input);
    expect(result.success).to.equal(false);
  });
});

describe('strategy parse helpers', () => {
  const CHAIN = 'ethereum';

  it('parseExtendedChainSubmissionStrategy tolerates non-writable Object prototype submitter', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      value: null,
    });

    try {
      const parsed = parseExtendedChainSubmissionStrategy(input as any);
      expect(parsed[CHAIN].submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedSubmissionStrategy tolerates non-writable Object prototype submitter', () => {
    const input = {
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      value: null,
    });

    try {
      const parsed = parseExtendedSubmissionStrategy(input as any);
      expect(parsed.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedChainSubmissionStrategy tolerates getter-only Object prototype submitter', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      get: () => null,
    });

    try {
      const parsed = parseExtendedChainSubmissionStrategy(input as any);
      expect(parsed[CHAIN].submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedSubmissionStrategy tolerates getter-only Object prototype submitter', () => {
    const input = {
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      get: () => null,
    });

    try {
      const parsed = parseExtendedSubmissionStrategy(input as any);
      expect(parsed.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedSubmissionStrategy tolerates non-writable Object prototype chain', () => {
    const input = {
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'chain',
    );
    Object.defineProperty(Object.prototype, 'chain', {
      configurable: true,
      enumerable: false,
      value: null,
    });

    try {
      const parsed = parseExtendedSubmissionStrategy(input as any);
      expect(parsed.submitter.type).to.equal(TxSubmitterType.JSON_RPC);
      expect((parsed.submitter as Record<string, unknown>).chain).to.equal(CHAIN);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Object.prototype, 'chain', originalDescriptor);
      } else {
        delete (Object.prototype as any).chain;
      }
    }
  });

  it('parseExtendedChainSubmissionStrategy tolerates non-writable Object prototype type', () => {
    const input = {
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'type',
    );
    Object.defineProperty(Object.prototype, 'type', {
      configurable: true,
      enumerable: false,
      value: null,
    });

    try {
      const parsed = parseExtendedChainSubmissionStrategy(input as any);
      expect(parsed[CHAIN].submitter.type).to.equal(TxSubmitterType.JSON_RPC);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Object.prototype, 'type', originalDescriptor);
      } else {
        delete (Object.prototype as any).type;
      }
    }
  });

  it('parseExtendedSubmissionStrategy restores non-writable prototype descriptor after parse errors', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    const nonWritableDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      writable: false,
      value: null,
    };
    Object.defineProperty(
      Object.prototype,
      'submitter',
      nonWritableDescriptor,
    );

    try {
      expect(() => parseExtendedSubmissionStrategy({} as any)).to.throw();
      const restoredDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'submitter',
      );
      expect(restoredDescriptor).to.not.equal(undefined);
      expect(restoredDescriptor?.configurable).to.equal(
        nonWritableDescriptor.configurable,
      );
      expect(restoredDescriptor?.enumerable).to.equal(
        nonWritableDescriptor.enumerable,
      );
      expect(restoredDescriptor?.writable).to.equal(
        nonWritableDescriptor.writable,
      );
      expect(restoredDescriptor?.value).to.equal(nonWritableDescriptor.value);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedChainSubmissionStrategy restores getter-only prototype descriptor after parse errors', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    const getter = () => null;
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      get: getter,
    });

    try {
      expect(
        () => parseExtendedChainSubmissionStrategy({ [CHAIN]: {} } as any),
      ).to.throw();
      const restoredDescriptor = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'submitter',
      );
      expect(restoredDescriptor).to.not.equal(undefined);
      expect(restoredDescriptor?.configurable).to.equal(true);
      expect(restoredDescriptor?.enumerable).to.equal(false);
      expect(restoredDescriptor?.get).to.equal(getter);
      expect(restoredDescriptor?.set).to.equal(undefined);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedSubmissionStrategy strips inherited submitterOverrides from output', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitterOverrides',
    );
    Object.defineProperty(Object.prototype, 'submitterOverrides', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        '0x1111111111111111111111111111111111111111': {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
      },
    });

    try {
      const parsed = parseExtendedSubmissionStrategy({
        submitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
      } as any);
      expect(
        Object.prototype.hasOwnProperty.call(parsed, 'submitterOverrides'),
      ).to.equal(false);
      expect((parsed as Record<string, unknown>).submitterOverrides).to.equal(
        undefined,
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitterOverrides',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitterOverrides;
      }
    }
  });

  it('parseExtendedChainSubmissionStrategy strips inherited nested submitterOverrides from output', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitterOverrides',
    );
    Object.defineProperty(Object.prototype, 'submitterOverrides', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        '0x1111111111111111111111111111111111111111': {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN,
        },
      },
    });

    try {
      const parsed = parseExtendedChainSubmissionStrategy({
        [CHAIN]: {
          submitter: {
            type: TxSubmitterType.JSON_RPC,
          },
        },
      } as any);
      const chainStrategy = parsed[CHAIN] as Record<string, unknown>;
      expect(
        Object.prototype.hasOwnProperty.call(chainStrategy, 'submitterOverrides'),
      ).to.equal(false);
      expect(chainStrategy.submitterOverrides).to.equal(undefined);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitterOverrides',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitterOverrides;
      }
    }
  });

  it('parseExtendedSubmissionStrategy preserves own empty submitterOverrides', () => {
    const parsed = parseExtendedSubmissionStrategy({
      submitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
      submitterOverrides: {},
    } as any);

    expect(
      Object.prototype.hasOwnProperty.call(parsed, 'submitterOverrides'),
    ).to.equal(true);
    expect(parsed.submitterOverrides).to.deep.equal({});
  });

  it('parseExtendedSubmissionStrategy rejects prototype-only submitter', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'submitter',
    );
    Object.defineProperty(Object.prototype, 'submitter', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN,
      },
    });

    try {
      expect(() => parseExtendedSubmissionStrategy({} as any)).to.throw();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Object.prototype,
          'submitter',
          originalDescriptor,
        );
      } else {
        delete (Object.prototype as any).submitter;
      }
    }
  });

  it('parseExtendedChainSubmissionStrategy drops empty nested submitterOverrides', () => {
    const parsed = parseExtendedChainSubmissionStrategy({
      [CHAIN]: {
        submitter: {
          type: TxSubmitterType.JSON_RPC,
        },
        submitterOverrides: {},
      },
    } as any);
    const chainStrategy = parsed[CHAIN] as Record<string, unknown>;

    expect(
      Object.prototype.hasOwnProperty.call(chainStrategy, 'submitterOverrides'),
    ).to.equal(false);
    expect(chainStrategy.submitterOverrides).to.equal(undefined);
  });
});
