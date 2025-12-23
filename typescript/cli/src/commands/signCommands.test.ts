import { expect } from 'chai';

import {
  CONDITIONAL_SIGN_COMMANDS,
  SIGN_COMMANDS,
  isSignCommand,
} from './signCommands.js';

describe('signCommands', () => {
  describe('isSignCommand', () => {
    it('returns true for commands in SIGN_COMMANDS', () => {
      for (const cmd of SIGN_COMMANDS) {
        expect(isSignCommand({ _: [cmd] })).to.be.true;
      }
    });

    it('returns true for subcommands in SIGN_COMMANDS', () => {
      for (const cmd of SIGN_COMMANDS) {
        expect(isSignCommand({ _: ['parent', cmd] })).to.be.true;
      }
    });

    it('returns false for non-sign commands', () => {
      expect(isSignCommand({ _: ['read'] })).to.be.false;
      expect(isSignCommand({ _: ['config'] })).to.be.false;
      expect(isSignCommand({ _: ['help'] })).to.be.false;
    });

    describe('conditional sign commands', () => {
      it('status command returns false without --relay flag', () => {
        expect(isSignCommand({ _: ['status'] })).to.be.false;
        expect(isSignCommand({ _: ['status'], relay: false })).to.be.false;
      });

      it('status command returns true with --relay flag', () => {
        expect(isSignCommand({ _: ['status'], relay: true })).to.be.true;
      });

      it('status subcommand returns false without --relay flag', () => {
        expect(isSignCommand({ _: ['parent', 'status'] })).to.be.false;
        expect(isSignCommand({ _: ['parent', 'status'], relay: false })).to.be
          .false;
      });

      it('status subcommand returns true with --relay flag', () => {
        expect(isSignCommand({ _: ['parent', 'status'], relay: true })).to.be
          .true;
      });
    });
  });

  describe('CONDITIONAL_SIGN_COMMANDS', () => {
    it('includes status command', () => {
      expect(CONDITIONAL_SIGN_COMMANDS).to.include('status');
    });
  });
});
