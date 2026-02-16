import { expect } from 'chai';

import {
  BUILTIN_SQUADS_ERROR_LABELS,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER,
  isGenericObjectStringifiedValue,
  normalizeStringifiedSquadsError,
  stringifyUnknownSquadsError,
} from './error-format.js';

describe('squads error-format', () => {
  it('exports built-in squads error labels', () => {
    expect(BUILTIN_SQUADS_ERROR_LABELS).to.deep.equal([
      'Error',
      'TypeError',
      'RangeError',
      'ReferenceError',
      'SyntaxError',
      'URIError',
      'EvalError',
      'AggregateError',
    ]);
  });

  it('exports built-in squads error labels as immutable runtime data', () => {
    expect(Object.isFrozen(BUILTIN_SQUADS_ERROR_LABELS)).to.equal(true);
    expect(() =>
      (BUILTIN_SQUADS_ERROR_LABELS as unknown as string[]).push('CustomError'),
    ).to.throw(TypeError);
  });

  describe(normalizeStringifiedSquadsError.name, () => {
    it('returns undefined for empty and whitespace-only strings', () => {
      expect(normalizeStringifiedSquadsError('')).to.equal(undefined);
      expect(normalizeStringifiedSquadsError('   ')).to.equal(undefined);
    });

    it('returns undefined for generic object stringification labels', () => {
      expect(normalizeStringifiedSquadsError('[object Object]')).to.equal(
        undefined,
      );
      expect(
        normalizeStringifiedSquadsError('  [object ErrorLike]  '),
      ).to.equal(undefined);
      expect(normalizeStringifiedSquadsError('[object Object]:')).to.equal(
        undefined,
      );
      expect(
        normalizeStringifiedSquadsError(' [object ErrorLike] :   '),
      ).to.equal(undefined);
    });

    it('returns undefined for bare built-in error labels', () => {
      for (const errorLabel of BUILTIN_SQUADS_ERROR_LABELS) {
        expect(normalizeStringifiedSquadsError(errorLabel)).to.equal(undefined);
        expect(normalizeStringifiedSquadsError(`${errorLabel}:`)).to.equal(
          undefined,
        );
        expect(
          normalizeStringifiedSquadsError(`  ${errorLabel} :   `),
        ).to.equal(undefined);
        expect(normalizeStringifiedSquadsError(`${errorLabel} :\n\t`)).to.equal(
          undefined,
        );
        expect(
          normalizeStringifiedSquadsError(errorLabel.toLowerCase()),
        ).to.equal(undefined);
      }
    });

    it('returns undefined for built-in error labels with generic-object messages', () => {
      expect(
        normalizeStringifiedSquadsError('Error: [object Object]'),
      ).to.equal(undefined);
      expect(
        normalizeStringifiedSquadsError('TypeError : [object CustomError]'),
      ).to.equal(undefined);
      expect(
        normalizeStringifiedSquadsError(' AggregateError: [object ErrorLike] '),
      ).to.equal(undefined);
    });

    it('returns undefined for built-in error labels with low-signal built-in messages', () => {
      expect(normalizeStringifiedSquadsError('Error: Error:')).to.equal(
        undefined,
      );
      expect(normalizeStringifiedSquadsError('TypeError: TypeError')).to.equal(
        undefined,
      );
      expect(
        normalizeStringifiedSquadsError('AggregateError : ReferenceError :'),
      ).to.equal(undefined);
    });

    it('preserves custom error-like labels and detailed messages', () => {
      expect(normalizeStringifiedSquadsError('RpcError')).to.equal('RpcError');
      expect(normalizeStringifiedSquadsError('Error: rpc failed')).to.equal(
        'Error: rpc failed',
      );
      expect(normalizeStringifiedSquadsError('Error : rpc failed')).to.equal(
        'Error : rpc failed',
      );
    });

    it('returns original untrimmed value for meaningful strings', () => {
      expect(normalizeStringifiedSquadsError('  rpc failed  ')).to.equal(
        '  rpc failed  ',
      );
    });

    it('returns undefined for non-string values', () => {
      expect(normalizeStringifiedSquadsError(null)).to.equal(undefined);
      expect(normalizeStringifiedSquadsError(1)).to.equal(undefined);
      expect(normalizeStringifiedSquadsError(false)).to.equal(undefined);
      expect(normalizeStringifiedSquadsError(Symbol('err'))).to.equal(
        undefined,
      );
      expect(normalizeStringifiedSquadsError(['Error'])).to.equal(undefined);
      expect(normalizeStringifiedSquadsError({ error: 'Error' })).to.equal(
        undefined,
      );
    });

    it('keeps normalization stable when Set.prototype.has is mutated', () => {
      const originalSetHas = Set.prototype.has;
      let normalizedBuiltinLabel: string | undefined;
      let normalizedDetailedLabel: string | undefined;

      Object.defineProperty(Set.prototype, 'has', {
        value: () => {
          throw new Error('set has unavailable');
        },
        writable: true,
        configurable: true,
      });
      try {
        normalizedBuiltinLabel = normalizeStringifiedSquadsError('Error');
        normalizedDetailedLabel =
          normalizeStringifiedSquadsError('Error: rpc failed');
      } finally {
        Object.defineProperty(Set.prototype, 'has', {
          value: originalSetHas,
          writable: true,
          configurable: true,
        });
      }

      expect(normalizedBuiltinLabel).to.equal(undefined);
      expect(normalizedDetailedLabel).to.equal('Error: rpc failed');
    });

    it('keeps normalization stable when String trim/lowercase prototypes are mutated', () => {
      const originalStringTrim = String.prototype.trim;
      const originalStringToLowerCase = String.prototype.toLowerCase;
      const throwingTrim: typeof String.prototype.trim = function trim() {
        throw new Error('string trim unavailable');
      };
      const throwingToLowerCase: typeof String.prototype.toLowerCase =
        function toLowerCase() {
          throw new Error('string toLowerCase unavailable');
        };
      let normalizedBuiltinLabel: string | undefined;
      let normalizedDetailedLabel: string | undefined;

      try {
        Object.defineProperty(String.prototype, 'trim', {
          value: throwingTrim,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(String.prototype, 'toLowerCase', {
          value: throwingToLowerCase,
          writable: true,
          configurable: true,
        });
        normalizedBuiltinLabel = normalizeStringifiedSquadsError(' Error ');
        normalizedDetailedLabel = normalizeStringifiedSquadsError(
          ' Error: rpc failed ',
        );
      } finally {
        Object.defineProperty(String.prototype, 'trim', {
          value: originalStringTrim,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(String.prototype, 'toLowerCase', {
          value: originalStringToLowerCase,
          writable: true,
          configurable: true,
        });
      }

      expect(normalizedBuiltinLabel).to.equal(undefined);
      expect(normalizedDetailedLabel).to.equal(' Error: rpc failed ');
    });
  });

  describe(isGenericObjectStringifiedValue.name, () => {
    it('detects generic object stringification with or without padding', () => {
      expect(isGenericObjectStringifiedValue('[object Object]')).to.equal(true);
      expect(
        isGenericObjectStringifiedValue('  [object CustomError]'),
      ).to.equal(true);
      expect(isGenericObjectStringifiedValue('[object Object]:')).to.equal(
        true,
      );
      expect(
        isGenericObjectStringifiedValue(' [object CustomError] : '),
      ).to.equal(true);
    });

    it('rejects non-generic object stringification values', () => {
      expect(isGenericObjectStringifiedValue('[objectObject]')).to.equal(false);
      expect(isGenericObjectStringifiedValue('object Object')).to.equal(false);
      expect(isGenericObjectStringifiedValue('Error: boom')).to.equal(false);
    });

    it('returns false for non-string values', () => {
      expect(isGenericObjectStringifiedValue(null)).to.equal(false);
      expect(isGenericObjectStringifiedValue(1)).to.equal(false);
      expect(isGenericObjectStringifiedValue(false)).to.equal(false);
      expect(isGenericObjectStringifiedValue(Symbol('obj'))).to.equal(false);
      expect(isGenericObjectStringifiedValue(['[object Object]'])).to.equal(
        false,
      );
      expect(
        isGenericObjectStringifiedValue({ value: '[object Object]' }),
      ).to.equal(false);
    });
  });

  describe(stringifyUnknownSquadsError.name, () => {
    it('stringifies Error instances with default Error prefix', () => {
      expect(stringifyUnknownSquadsError(new Error('boom'))).to.equal(
        'Error: boom',
      );
    });

    it('returns placeholder when Error instance inspection is unreadable', () => {
      const { proxy: revokedError, revoke } = Proxy.revocable({}, {});
      revoke();

      expect(
        stringifyUnknownSquadsError(revokedError, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('supports message-first formatting for Error instances', () => {
      expect(
        stringifyUnknownSquadsError(new Error('boom'), {
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('boom');
    });

    it('supports stack-first formatting for Error instances', () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n at sample.ts:1:1';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('Error: boom\n at sample.ts:1:1');
    });

    it('falls back to message when preferred Error stack access throws', () => {
      const error = new Error('boom');
      Object.defineProperty(error, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('boom');
    });

    it('falls back to String(error) when preferred Error stack throws and message is low-signal', () => {
      const error = new Error('');
      Object.defineProperty(error, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });
      error.toString = () => 'custom string fallback';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('custom string fallback');
    });

    it('falls back to String(error) when preferred Error message access throws', () => {
      const error = new Error('boom');
      Object.defineProperty(error, 'message', {
        configurable: true,
        get() {
          throw new Error('message unavailable');
        },
      });
      error.toString = () => 'custom error fallback';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('custom error fallback');
    });

    it('falls back to String(error) when preferred Error message is low-signal', () => {
      const error = new Error('');
      error.toString = () => 'custom low-signal fallback';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('custom low-signal fallback');
    });

    it('falls back to message when preferred Error stack is low-signal', () => {
      const error = new Error('boom');
      error.stack = 'Error';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('boom');
    });

    it('falls back to String(error) when stack is low-signal and message preference is disabled', () => {
      const error = new Error('boom');
      error.stack = 'TypeError:';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
        }),
      ).to.equal('Error: boom');
    });

    it('falls back to String(error) when preferred stack/message are low-signal labels', () => {
      const error = new Error('boom');
      Object.defineProperty(error, 'stack', {
        configurable: true,
        get() {
          return 'TypeError:';
        },
      });
      Object.defineProperty(error, 'message', {
        configurable: true,
        get() {
          return 'Error :';
        },
      });
      error.toString = () => 'custom low-signal chain fallback';

      expect(
        stringifyUnknownSquadsError(error, {
          preferErrorStackForErrorInstances: true,
          preferErrorMessageForErrorInstances: true,
        }),
      ).to.equal('custom low-signal chain fallback');
    });

    it('returns placeholder for low-signal Error stringification', () => {
      const error = new Error('');

      expect(
        stringifyUnknownSquadsError(error, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('returns placeholder for Error instances with generic-object messages', () => {
      const error = new Error('[object Object]');

      expect(
        stringifyUnknownSquadsError(error, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('returns placeholder for Error instances with low-signal built-in messages', () => {
      const error = new Error('Error:');

      expect(
        stringifyUnknownSquadsError(error, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('prefers object stack then message before final fallback', () => {
      expect(
        stringifyUnknownSquadsError({
          stack: 'Error: boom\n at sample.ts:1:1',
          message: 'boom',
        }),
      ).to.equal('Error: boom\n at sample.ts:1:1');
      expect(
        stringifyUnknownSquadsError({
          stack: '   ',
          message: 'boom',
        }),
      ).to.equal('boom');
    });

    it('falls back to object message when stack accessor throws', () => {
      const errorLike = { message: 'boom' } as {
        message: string;
        stack?: string;
      };
      Object.defineProperty(errorLike, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });

      expect(stringifyUnknownSquadsError(errorLike)).to.equal('boom');
    });

    it('supports placeholder overrides', () => {
      expect(
        stringifyUnknownSquadsError('   ', {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('uses exported default placeholder when option is omitted', () => {
      expect(stringifyUnknownSquadsError('   ')).to.equal(
        DEFAULT_SQUADS_ERROR_PLACEHOLDER,
      );
    });

    it('falls back to exported default placeholder when placeholder override is empty', () => {
      expect(
        stringifyUnknownSquadsError('   ', {
          placeholder: '',
        }),
      ).to.equal(DEFAULT_SQUADS_ERROR_PLACEHOLDER);
    });

    it('falls back to exported default placeholder when placeholder override is whitespace', () => {
      expect(
        stringifyUnknownSquadsError('   ', {
          placeholder: '   ',
        }),
      ).to.equal(DEFAULT_SQUADS_ERROR_PLACEHOLDER);
    });

    it('tolerates malformed options containers by falling back to defaults', () => {
      expect(stringifyUnknownSquadsError('   ', null)).to.equal(
        DEFAULT_SQUADS_ERROR_PLACEHOLDER,
      );
      expect(stringifyUnknownSquadsError('   ', 1)).to.equal(
        DEFAULT_SQUADS_ERROR_PLACEHOLDER,
      );
      expect(stringifyUnknownSquadsError('   ', 'bad-options')).to.equal(
        DEFAULT_SQUADS_ERROR_PLACEHOLDER,
      );
    });

    it('tolerates option accessors that throw by falling back to defaults', () => {
      const malformedOptions = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(malformedOptions, 'placeholder', {
        configurable: true,
        get() {
          throw new Error('placeholder unavailable');
        },
      });
      Object.defineProperty(
        malformedOptions,
        'preferErrorMessageForErrorInstances',
        {
          configurable: true,
          get() {
            throw new Error('message preference unavailable');
          },
        },
      );

      expect(stringifyUnknownSquadsError('   ', malformedOptions)).to.equal(
        DEFAULT_SQUADS_ERROR_PLACEHOLDER,
      );
      expect(
        stringifyUnknownSquadsError(new Error('boom'), malformedOptions),
      ).to.equal('Error: boom');
    });

    it('tolerates throwing formatObject accessors and falls back to stringification', () => {
      const malformedOptions = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(malformedOptions, 'formatObject', {
        configurable: true,
        get() {
          throw new Error('formatObject unavailable');
        },
      });
      const errorLike = {
        toString() {
          return 'object fallback';
        },
      };

      expect(stringifyUnknownSquadsError(errorLike, malformedOptions)).to.equal(
        'object fallback',
      );
    });

    it('supports object formatter callbacks for plain objects', () => {
      expect(
        stringifyUnknownSquadsError(
          { foo: 'bar' },
          {
            formatObject(value) {
              return JSON.stringify(value);
            },
          },
        ),
      ).to.equal('{"foo":"bar"}');
    });

    it('ignores non-string object formatter outputs and falls back', () => {
      expect(
        stringifyUnknownSquadsError(
          {
            toString() {
              return 'custom object fallback';
            },
          },
          {
            formatObject() {
              return 123 as unknown as string;
            },
          },
        ),
      ).to.equal('custom object fallback');
    });

    it('does not call object formatter for Error instances', () => {
      let formatterCallCount = 0;
      const formatted = stringifyUnknownSquadsError(new Error('boom'), {
        formatObject() {
          formatterCallCount += 1;
          return 'formatted object';
        },
      });

      expect(formatted).to.equal('Error: boom');
      expect(formatterCallCount).to.equal(0);
    });

    it('does not call object formatter when object stack is usable', () => {
      let formatterCallCount = 0;
      const formatted = stringifyUnknownSquadsError(
        {
          stack: 'Error: boom\n at sample.ts:1:1',
          message: 'boom',
        },
        {
          formatObject() {
            formatterCallCount += 1;
            return 'formatted object';
          },
        },
      );

      expect(formatted).to.equal('Error: boom\n at sample.ts:1:1');
      expect(formatterCallCount).to.equal(0);
    });

    it('does not call object formatter when object message is usable', () => {
      let formatterCallCount = 0;
      const formatted = stringifyUnknownSquadsError(
        {
          stack: 'Error',
          message: 'boom',
        },
        {
          formatObject() {
            formatterCallCount += 1;
            return 'formatted object';
          },
        },
      );

      expect(formatted).to.equal('boom');
      expect(formatterCallCount).to.equal(0);
    });

    it('calls object formatter when object stack/message are low-signal', () => {
      let formatterCallCount = 0;
      const formatted = stringifyUnknownSquadsError(
        {
          stack: 'Error',
          message: '   ',
        },
        {
          formatObject() {
            formatterCallCount += 1;
            return 'formatted object';
          },
        },
      );

      expect(formatted).to.equal('formatted object');
      expect(formatterCallCount).to.equal(1);
    });

    it('calls object formatter when stack getter throws and message is low-signal', () => {
      let formatterCallCount = 0;
      const objectWithThrowingStackGetter = {
        message: 'Error:',
      } as { stack?: string; message: string };
      Object.defineProperty(objectWithThrowingStackGetter, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });

      const formatted = stringifyUnknownSquadsError(
        objectWithThrowingStackGetter,
        {
          formatObject() {
            formatterCallCount += 1;
            return 'formatted object';
          },
        },
      );

      expect(formatted).to.equal('formatted object');
      expect(formatterCallCount).to.equal(1);
    });

    it('ignores low-signal object formatter outputs and falls back', () => {
      const formatted = stringifyUnknownSquadsError(
        {
          toString() {
            return 'custom object error';
          },
        },
        {
          formatObject() {
            return '[object CustomErrorLike]';
          },
        },
      );

      expect(formatted).to.equal('custom object error');
    });

    it('falls back when object formatter throws', () => {
      const formatted = stringifyUnknownSquadsError(
        {
          toString() {
            return 'custom object error';
          },
        },
        {
          formatObject() {
            throw new Error('cannot serialize');
          },
        },
      );

      expect(formatted).to.equal('custom object error');
    });

    it('returns placeholder when formatter throws and final String(error) fallback throws', () => {
      const unstringifiableObject = {
        toString() {
          throw new Error('cannot stringify');
        },
      } as {
        stack?: string;
        message?: string;
        toString: () => string;
      };
      Object.defineProperty(unstringifiableObject, 'stack', {
        configurable: true,
        get() {
          return '   ';
        },
      });
      Object.defineProperty(unstringifiableObject, 'message', {
        configurable: true,
        get() {
          return '   ';
        },
      });

      expect(
        stringifyUnknownSquadsError(unstringifiableObject, {
          placeholder: '[fallback]',
          formatObject() {
            throw new Error('cannot serialize');
          },
        }),
      ).to.equal('[fallback]');
    });

    it('falls back to String(error) when object formatter returns low-signal text', () => {
      const formatted = stringifyUnknownSquadsError(
        {
          toString() {
            return 'custom object fallback';
          },
        },
        {
          formatObject() {
            return '   ';
          },
        },
      );

      expect(formatted).to.equal('custom object fallback');
    });

    it('falls back to String(error) when object formatter returns low-signal built-in labels and variants', () => {
      for (const errorLabel of BUILTIN_SQUADS_ERROR_LABELS) {
        const lowSignalFormatterOutputs = [
          errorLabel,
          `${errorLabel}:`,
          `  ${errorLabel} :   `,
          errorLabel.toLowerCase(),
        ] as const;

        for (const formatterOutput of lowSignalFormatterOutputs) {
          const formatted = stringifyUnknownSquadsError(
            {
              toString() {
                return 'custom object fallback';
              },
            },
            {
              formatObject() {
                return formatterOutput;
              },
            },
          );

          expect(formatted).to.equal('custom object fallback');
        }
      }
    });

    it('returns placeholder when final String(error) fallback throws', () => {
      const unstringifiableValue = (() => 'noop') as unknown as {
        toString: () => string;
      };
      unstringifiableValue.toString = () => {
        throw new Error('cannot stringify');
      };

      expect(
        stringifyUnknownSquadsError(unstringifiableValue, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('returns placeholder when only generic object-string output is available', () => {
      const errorLike = {
        toString() {
          return '[object CustomErrorLike]';
        },
      } as { toString: () => string; stack?: string; message?: string };
      Object.defineProperty(errorLike, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });
      Object.defineProperty(errorLike, 'message', {
        configurable: true,
        get() {
          throw new Error('message unavailable');
        },
      });

      expect(
        stringifyUnknownSquadsError(errorLike, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('returns placeholder when stack/message access and String(error) all throw', () => {
      const unstringifiableErrorLike = {} as {
        stack?: string;
        message?: string;
        toString: () => string;
      };
      Object.defineProperty(unstringifiableErrorLike, 'stack', {
        configurable: true,
        get() {
          throw new Error('stack unavailable');
        },
      });
      Object.defineProperty(unstringifiableErrorLike, 'message', {
        configurable: true,
        get() {
          throw new Error('message unavailable');
        },
      });
      unstringifiableErrorLike.toString = () => {
        throw new Error('cannot stringify');
      };

      expect(
        stringifyUnknownSquadsError(unstringifiableErrorLike, {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });
  });
});
