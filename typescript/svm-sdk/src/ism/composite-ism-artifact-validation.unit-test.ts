import { address as parseAddress } from '@solana/kit';
import { expect } from 'chai';

import type {
  CompositeIsmArtifactConfig,
  CompositeIsmNodeArtifactConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { assertValidCompositeIsmArtifact } from './composite-ism.js';

const OWNER = '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf';
const OTHER_PUBKEY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ZERO_PUBKEY = '1'.repeat(32);
const VALIDATOR = '0x1111111111111111111111111111111111111111';
const OTHER_VALIDATOR = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x' + '5'.repeat(64);
const ZERO_RECIPIENT = '0x' + '0'.repeat(64);

function config(
  root: CompositeIsmNodeArtifactConfig,
): CompositeIsmArtifactConfig {
  return { type: 'compositeIsm', owner: OWNER, root };
}

describe('assertValidCompositeIsmArtifact', () => {
  it('accepts a valid tree', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'trustedRelayer', relayer: OTHER_PUBKEY }),
      ),
    ).to.not.throw();
  });

  it('rejects a non-Sealevel owner', () => {
    expect(() =>
      assertValidCompositeIsmArtifact({
        type: 'compositeIsm',
        owner: '0x1111111111111111111111111111111111111111',
        root: { type: 'trustedRelayer', relayer: OTHER_PUBKEY },
      }),
    ).to.throw(/owner/);
  });

  it('rejects a base58-alphabet string that does not decode to a real pubkey', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'trustedRelayer', relayer: 'z'.repeat(32) }),
      ),
    ).to.throw(/relayer/);
  });

  it('rejects a zero trustedRelayer', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'trustedRelayer', relayer: ZERO_PUBKEY }),
      ),
    ).to.throw(/relayer/);
  });

  it('rejects duplicate validators', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'multisigMessageId',
          threshold: 1,
          validators: [VALIDATOR, '0x' + VALIDATOR.slice(2).toUpperCase()],
        }),
      ),
    ).to.throw(/Duplicate validator/);
  });

  it('rejects an invalid H160 validator address', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'multisigMessageId',
          threshold: 1,
          validators: [OTHER_PUBKEY],
        }),
      ),
    ).to.throw(/Invalid H160/);
  });

  it('rejects a multisigMessageId threshold above u8::MAX', () => {
    const validators = Array.from(
      { length: 256 },
      (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'),
    );
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'multisigMessageId', threshold: 256, validators }),
      ),
    ).to.throw(/threshold/);
  });

  it('rejects an aggregation threshold out of range', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'aggregation',
          threshold: 5,
          subIsms: [{ type: 'trustedRelayer', relayer: OTHER_PUBKEY }],
        }),
      ),
    ).to.throw(/threshold/);
  });

  it('rejects fallbackRouting nested anywhere but last in an aggregation', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'aggregation',
          threshold: 2,
          subIsms: [
            { type: 'fallbackRouting', fallbackIsm: OTHER_PUBKEY },
            { type: 'trustedRelayer', relayer: OTHER_PUBKEY },
          ],
        }),
      ),
    ).to.throw(/fallbackRouting must be the last/);
  });

  it('rejects more than one routing/fallbackRouting node', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'aggregation',
          threshold: 1,
          subIsms: [
            { type: 'routing' },
            { type: 'fallbackRouting', fallbackIsm: OTHER_PUBKEY },
          ],
        }),
      ),
    ).to.throw(/Only one routing/);
  });

  it('rejects routing/fallbackRouting/pausable nested inside a domain override', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: { 1: { type: 'pausable', paused: false } },
        }),
      ),
    ).to.throw(/not allowed inside a domain override/);
  });

  it('rejects a rateLimited node missing a recipient', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: '86400',
          mailbox: OWNER,
        }),
      ),
    ).to.throw(/recipient/);
  });

  it('rejects a rateLimited node with a zero recipient', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: '86400',
          mailbox: OWNER,
          recipient: ZERO_RECIPIENT,
        }),
      ),
    ).to.throw(/non-zero/);
  });

  it('rejects a rateLimited node with a zero mailbox', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: '86400',
          mailbox: ZERO_PUBKEY,
          recipient: RECIPIENT,
        }),
      ),
    ).to.throw(/mailbox/);
  });

  it('rejects a fallbackRouting node with a zero fallbackIsm', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'fallbackRouting', fallbackIsm: ZERO_PUBKEY }),
      ),
    ).to.throw(/fallbackIsm/);
  });

  it('rejects a rateLimited node with a non-Sealevel mailbox', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: '86400',
          mailbox: '0x1111111111111111111111111111111111111111',
          recipient: RECIPIENT,
        }),
      ),
    ).to.throw(/mailbox/);
  });

  it('rejects a rateLimited maxCapacity above u64::MAX', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: (2n ** 64n).toString(),
          mailbox: OWNER,
          recipient: RECIPIENT,
        }),
      ),
    ).to.throw(/maxCapacity/);
  });

  it('rejects an amountRouting threshold above u256::MAX', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'amountRouting',
          threshold: (2n ** 256n).toString(),
          lower: { type: 'test', accept: true },
          upper: { type: 'test', accept: false },
        }),
      ),
    ).to.throw(/threshold/);
  });

  it('rejects malformed decimal strings without throwing an unrelated error', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'rateLimited',
          maxCapacity: 'not-a-number',
          mailbox: OWNER,
          recipient: RECIPIENT,
        }),
      ),
    ).to.throw(/maxCapacity/);
  });

  it('accepts a distinct second validator pair', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'multisigMessageId',
          threshold: 1,
          validators: [VALIDATOR, OTHER_VALIDATOR],
        }),
      ),
    ).to.not.throw();
  });

  it('rejects a fractional multisigMessageId threshold', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'multisigMessageId',
          threshold: 1.5,
          validators: [VALIDATOR, OTHER_VALIDATOR],
        }),
      ),
    ).to.throw(/threshold/);
  });

  it('rejects a fractional aggregation threshold', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'aggregation',
          threshold: 1.5,
          subIsms: [
            { type: 'trustedRelayer', relayer: OTHER_PUBKEY },
            { type: 'trustedRelayer', relayer: OWNER },
          ],
        }),
      ),
    ).to.throw(/threshold/);
  });

  it('rejects a zero owner', () => {
    expect(() =>
      assertValidCompositeIsmArtifact({
        type: 'compositeIsm',
        owner: ZERO_PUBKEY,
        root: { type: 'trustedRelayer', relayer: OTHER_PUBKEY },
      }),
    ).to.throw(/owner/);
  });

  it('rejects a fractional domain map key', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: { '1.5': { type: 'trustedRelayer', relayer: OTHER_PUBKEY } },
        }),
      ),
    ).to.throw(/domains key/);
  });

  it('rejects a non-canonical domain map key (leading zero)', () => {
    const nonCanonicalKey: string = '01';
    const domainNode: CompositeIsmNodeArtifactConfig = {
      type: 'trustedRelayer',
      relayer: OTHER_PUBKEY,
    };
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: { [nonCanonicalKey]: domainNode },
        }),
      ),
    ).to.throw(/domains key/);
  });

  it('rejects a negative domain map key', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: { '-1': { type: 'trustedRelayer', relayer: OTHER_PUBKEY } },
        }),
      ),
    ).to.throw(/domains key/);
  });

  it('rejects a domain map key overflowing u32', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: {
            '4294967296': { type: 'trustedRelayer', relayer: OTHER_PUBKEY },
          },
        }),
      ),
    ).to.throw(/domains key/);
  });

  it('accepts a canonical zero domain map key', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({
          type: 'routing',
          domains: { '0': { type: 'trustedRelayer', relayer: OTHER_PUBKEY } },
        }),
      ),
    ).to.not.throw();
  });

  it('rejects a fallbackRouting fallbackIsm that self-references the program ID', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'fallbackRouting', fallbackIsm: OTHER_PUBKEY }),
        parseAddress(OTHER_PUBKEY),
      ),
    ).to.throw(/must not be the composite ISM's own program ID/);
  });

  it('accepts a fallbackRouting fallbackIsm distinct from the program ID', () => {
    expect(() =>
      assertValidCompositeIsmArtifact(
        config({ type: 'fallbackRouting', fallbackIsm: OTHER_PUBKEY }),
        parseAddress(OWNER),
      ),
    ).to.not.throw();
  });
});
