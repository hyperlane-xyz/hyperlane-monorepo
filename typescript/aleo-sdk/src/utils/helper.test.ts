import { expect } from 'chai';

import { ALEO_PROGRAMS } from '../programs.js';

import { getProgramSuffix } from './helper.js';

describe('getProgramSuffix', () => {
  it('uses the generated program metadata', () => {
    expect(ALEO_PROGRAMS).to.include('mailbox');
    expect(getProgramSuffix('hyp_mailbox_abc123.aleo')).to.equal('abc123');
  });

  it('removes the testnet prefix', () => {
    expect(getProgramSuffix('test_hyp_mailbox_abc123.aleo')).to.equal('abc123');
  });
});
