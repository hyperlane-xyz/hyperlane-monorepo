import { expect } from 'chai';

import {
  isGenericObjectStringifiedValue,
  normalizeStringifiedSquadsError,
} from './error-format.js';

describe('squads error-format', () => {
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
      expect(normalizeStringifiedSquadsError('Error')).to.equal(undefined);
      expect(normalizeStringifiedSquadsError('TypeError:')).to.equal(undefined);
      expect(normalizeStringifiedSquadsError('Error :')).to.equal(undefined);
      expect(normalizeStringifiedSquadsError('  TypeError :   ')).to.equal(
        undefined,
      );
      expect(normalizeStringifiedSquadsError('referenceerror')).to.equal(
        undefined,
      );
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
});
