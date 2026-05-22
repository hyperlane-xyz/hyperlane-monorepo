import { expect } from 'chai';

import { syntheticCcrSwapMessageId } from './messages.js';

// Fixture values shared with the Rust counterpart in
// rust/main/agents/scraper/src/db/same_chain_ccr_swap.rs (see #[cfg(test)]).
// Both sides must produce the identical hex string for the same inputs.
const TX_HASH =
  '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
const LOG_INDEX = 7;
// Expected: 0x00000000 || keccak256("SameChainCCR" || TX_HASH || 0x0000000000000007)[0..28]
const EXPECTED_MSG_ID =
  '0x000000001620870f00662d2235b9ddf02edd63c54ae359b191e04ffacff719e6';

describe('syntheticCcrSwapMessageId', () => {
  it('matches the Rust fixture', () => {
    expect(syntheticCcrSwapMessageId(TX_HASH, LOG_INDEX)).to.equal(
      EXPECTED_MSG_ID,
    );
  });

  it('accepts bigint logIndex', () => {
    expect(syntheticCcrSwapMessageId(TX_HASH, BigInt(LOG_INDEX))).to.equal(
      EXPECTED_MSG_ID,
    );
  });

  it('produces a 66-char 0x-prefixed hex string', () => {
    const id = syntheticCcrSwapMessageId(TX_HASH, LOG_INDEX);
    expect(id).to.match(/^0x[0-9a-f]{64}$/);
  });

  it('has a 4-byte zero prefix', () => {
    const id = syntheticCcrSwapMessageId(TX_HASH, LOG_INDEX);
    expect(id.slice(0, 10)).to.equal('0x00000000');
  });

  it('differs for different logIndex', () => {
    const a = syntheticCcrSwapMessageId(TX_HASH, 0);
    const b = syntheticCcrSwapMessageId(TX_HASH, 1);
    expect(a).to.not.equal(b);
  });

  it('throws on invalid txHash', () => {
    expect(() => syntheticCcrSwapMessageId('0xdeadbeef', 0)).to.throw();
  });

  it('throws on negative logIndex', () => {
    expect(() => syntheticCcrSwapMessageId(TX_HASH, -1)).to.throw();
  });
});
