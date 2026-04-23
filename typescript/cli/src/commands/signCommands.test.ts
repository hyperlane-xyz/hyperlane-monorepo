import { expect } from 'vitest';

import {
  CONDITIONAL_SIGN_COMMANDS,
  SIGN_COMMANDS,
  isSignCommand,
} from './signCommands.js';

describe('signCommands', () => {
  describe('isSignCommand', () => {
    it('returns true for commands in SIGN_COMMANDS', () => {
      for (const cmd of SIGN_COMMANDS) {
        expect(isSignCommand({ _: [cmd] })).toBe(true);
      }
    });

    it('returns true for subcommands in SIGN_COMMANDS', () => {
      for (const cmd of SIGN_COMMANDS) {
        expect(isSignCommand({ _: ['parent', cmd] })).toBe(true);
      }
    });

    it('returns false for non-sign commands', () => {
      expect(isSignCommand({ _: ['read'] })).toBe(false);
      expect(isSignCommand({ _: ['config'] })).toBe(false);
      expect(isSignCommand({ _: ['help'] })).toBe(false);
    });

    describe('conditional sign commands', () => {
      it('status command returns false without --relay flag', () => {
        expect(isSignCommand({ _: ['status'] })).toBe(false);
        expect(isSignCommand({ _: ['status'], relay: false })).toBe(false);
      });

      it('status command returns true with --relay flag', () => {
        expect(isSignCommand({ _: ['status'], relay: true })).toBe(true);
      });

      it('status subcommand returns false without --relay flag', () => {
        expect(isSignCommand({ _: ['parent', 'status'] })).toBe(false);
        expect(isSignCommand({ _: ['parent', 'status'], relay: false })).toBe(
          false,
        );
      });

      it('status subcommand returns true with --relay flag', () => {
        expect(isSignCommand({ _: ['parent', 'status'], relay: true })).toBe(
          true,
        );
      });
    });
  });

  describe('CONDITIONAL_SIGN_COMMANDS', () => {
    it('includes status command', () => {
      expect(CONDITIONAL_SIGN_COMMANDS).toContain('status');
    });
  });
});
