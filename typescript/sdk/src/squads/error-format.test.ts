import { expect } from 'chai';

import {
  BUILTIN_SQUADS_ERROR_LABELS,
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
      expect(normalizeStringifiedSquadsError('  [object ErrorLike]  ')).to.equal(
        undefined,
      );
    });

    it('returns undefined for bare built-in error labels', () => {
      for (const errorLabel of BUILTIN_SQUADS_ERROR_LABELS) {
        expect(normalizeStringifiedSquadsError(errorLabel)).to.equal(undefined);
        expect(normalizeStringifiedSquadsError(`${errorLabel}:`)).to.equal(
          undefined,
        );
        expect(normalizeStringifiedSquadsError(`  ${errorLabel} :   `)).to.equal(
          undefined,
        );
        expect(
          normalizeStringifiedSquadsError(`${errorLabel} :\n\t`),
        ).to.equal(undefined);
        expect(
          normalizeStringifiedSquadsError(errorLabel.toLowerCase()),
        ).to.equal(undefined);
      }
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
  });

  describe(isGenericObjectStringifiedValue.name, () => {
    it('detects generic object stringification with or without padding', () => {
      expect(isGenericObjectStringifiedValue('[object Object]')).to.equal(true);
      expect(isGenericObjectStringifiedValue('  [object CustomError]')).to.equal(
        true,
      );
    });

    it('rejects non-generic object stringification values', () => {
      expect(isGenericObjectStringifiedValue('[objectObject]')).to.equal(false);
      expect(isGenericObjectStringifiedValue('object Object')).to.equal(false);
      expect(isGenericObjectStringifiedValue('Error: boom')).to.equal(false);
    });
  });

  describe(stringifyUnknownSquadsError.name, () => {
    it('stringifies Error instances with default Error prefix', () => {
      expect(stringifyUnknownSquadsError(new Error('boom'))).to.equal(
        'Error: boom',
      );
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

    it('returns placeholder for low-signal Error stringification', () => {
      const error = new Error('');

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

    it('supports placeholder overrides', () => {
      expect(
        stringifyUnknownSquadsError('   ', {
          placeholder: '[fallback]',
        }),
      ).to.equal('[fallback]');
    });

    it('supports object formatter callbacks for plain objects', () => {
      expect(
        stringifyUnknownSquadsError({ foo: 'bar' }, {
          formatObject(value) {
            return JSON.stringify(value);
          },
        }),
      ).to.equal('{"foo":"bar"}');
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

    it('falls back to String(error) when object formatter returns low-signal built-in labels', () => {
      const formatted = stringifyUnknownSquadsError(
        {
          toString() {
            return 'custom object fallback';
          },
        },
        {
          formatObject() {
            return 'Error:';
          },
        },
      );

      expect(formatted).to.equal('custom object fallback');
    });
  });
});
