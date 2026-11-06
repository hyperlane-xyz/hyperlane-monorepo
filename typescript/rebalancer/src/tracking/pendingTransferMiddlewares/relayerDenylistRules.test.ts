import { expect } from 'chai';
import { readFileSync } from 'node:fs';

import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import type { ExplorerMessage } from '../../utils/ExplorerClient.js';

import {
  DenylistLoadError,
  DenylistLoadFailure,
  findDenyReason,
  parseDenylistAddress,
  parseDenylistFile,
  parseRfc3339,
} from './relayerDenylistRules.js';

const MESSAGE_ID =
  '0x8960c5e41eb0d91973140ebc196892f5f07f512dd86047e8536e71424462c5d3';
const OTHER_MESSAGE_ID =
  '0xdae65a8dd678bf8ea03faed7d53b99e52f5bdbae7c95834eff009cc37a18103c';
const ORIGIN_ROUTER = '0x867a19a5b257bcb99e1840de2ef852268efd5e46';
const DESTINATION_ROUTER = '0x67899664446ccfadf75e0d3f5668be262acd1069';
const TX_SENDER = '0x995a921d333029512aa166885856c8af760e9381';
const WARP_RECIPIENT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const UNRELATED_ADDRESS = '0x1111111111111111111111111111111111111111';
const BODY_ADDRESS = '0xA0e768A68ba1BFffb9F4366dfC8D9195EE7217d1';
const TRON_ADDRESS = 'TG5iBMQPrDzJJAUM8GMVBf1hRaJ1wvzsGi';
const TRON_ADDRESS_BAD_CHECKSUM = 'TG5iBMQQf6E7GJWPU1eU9qdP9oQw4wKo3L';
const SOLANA_ADDRESS = 'AffzFDKZbyMiU11zmVBoAqD25ugpr7xoWWyRyGigBEaU';
const NOW = Date.parse('2026-11-04T00:00:00Z');
// From rust/main/app-contexts/mainnet_config.json.
const MAINNET_BODY_PREFIX =
  '0100000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c';
const MAINNET_BODY_REGEX = `^${MAINNET_BODY_PREFIX}.{64}`;

function buildMessage(
  fields: Pick<ExplorerMessage, 'msg_id'> &
    Partial<
      Pick<
        ExplorerMessage,
        | 'origin_domain_id'
        | 'destination_domain_id'
        | 'sender'
        | 'recipient'
        | 'origin_tx_sender'
        | 'message_body'
      >
    >,
): ExplorerMessage {
  return {
    msg_id: fields.msg_id,
    origin_domain_id: fields.origin_domain_id ?? 42161,
    destination_domain_id: fields.destination_domain_id ?? 1,
    sender: fields.sender ?? ORIGIN_ROUTER,
    recipient: fields.recipient ?? DESTINATION_ROUTER,
    origin_tx_hash:
      '0x5e3c1f6a3c1a7f86e0f2d5e9c9c1b8d1e1e7e2b6c4d8a9f0e1d2c3b4a5968778',
    origin_tx_sender: fields.origin_tx_sender ?? TX_SENDER,
    origin_tx_recipient: ORIGIN_ROUTER,
    is_delivered: false,
    message_body:
      fields.message_body ??
      `0x000000000000000000000000${WARP_RECIPIENT.slice(2)}${'0'.repeat(56)}05f5e100`,
    send_occurred_at: null,
  };
}

function rulesFile(rules: unknown[]): string {
  return JSON.stringify({ rules });
}

const BASE_RULE = { reason: 'test', addedBy: 'tester' };

function captureLoadError(text: string): DenylistLoadError {
  try {
    parseDenylistFile(text);
  } catch (error: unknown) {
    if (error instanceof DenylistLoadError) return error;
    throw error;
  }

  return expect.fail('Expected parseDenylistFile to throw');
}

describe('relayerDenylistRules', () => {
  describe('parseDenylistAddress', () => {
    interface AddressCase {
      name: string;
      input: string;
      expected: string;
    }
    const cases: AddressCase[] = [
      {
        name: '20-byte EVM hex',
        input: '0x67899664446CCfAdf75e0D3F5668be262aCd1069',
        expected:
          '0x00000000000000000000000067899664446ccfadf75e0d3f5668be262acd1069',
      },
      {
        name: '32-byte hex',
        input:
          '0x8960C5E41EB0D91973140EBC196892F5F07F512DD86047E8536E71424462C5D3',
        expected: MESSAGE_ID,
      },
      {
        name: 'Tron base58',
        input: TRON_ADDRESS,
        expected:
          '0x000000000000000000000000430b9b4a60d18affe500b731a97b5aa622c7863f',
      },
      {
        name: 'Solana base58',
        input: SOLANA_ADDRESS,
        expected:
          '0x8fa155f74d49e7464faa0d27041225f2ec5b8a5632fc68efb022d57946ec19c9',
      },
      {
        name: 'bech32',
        input: 'cosmos1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3pahzj0',
        expected:
          '0x0000000000000000000000001111111111111111111111111111111111111111',
      },
      {
        name: '20-byte zero hex',
        input: '0x0000000000000000000000000000000000000000',
        expected: ZERO_ADDRESS_HEX_32,
      },
      {
        name: 'bech32m',
        input:
          'account_rdx1cy3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zk3cl7y',
        expected:
          '0x0000c12222222222222222222222222222222222222222222222222222222222',
      },
    ];
    for (const c of cases) {
      it(`parses ${c.name}`, () => {
        expect(parseDenylistAddress(c.input)).to.equal(c.expected);
      });
    }

    const invalid = [
      '0x1234',
      '0xzz899664446ccfadf75e0d3f5668be262acd1069',
      TRON_ADDRESS_BAD_CHECKSUM,
      '*',
      'not-an-address',
    ];
    for (const input of invalid) {
      it(`rejects ${input}`, () => {
        expect(() => parseDenylistAddress(input)).to.throw();
      });
    }
  });

  describe('parseRfc3339', () => {
    interface TimestampCase {
      input: string;
      expected: number | undefined;
    }
    const cases: TimestampCase[] = [
      { input: '2026-12-01T00:00:00Z', expected: 1796083200000 },
      { input: '2026-12-01 00:00:00Z', expected: 1796083200000 },
      { input: '2026-12-01t00:00:00z', expected: 1796083200000 },
      { input: '2026-12-01T01:30:00+01:30', expected: 1796083200000 },
      { input: '2026-11-30T23:00:00-01:00', expected: 1796083200000 },
      { input: '2026-12-01T00:00:00.5Z', expected: 1796083200500 },
      { input: '2028-02-29T00:00:00Z', expected: 1835395200000 },
      { input: 'soon', expected: undefined },
      { input: '2026-12-01T00:00Z', expected: undefined },
      { input: '2026-12-01T00:00:00', expected: undefined },
      { input: '2026-12-01_00:00:00Z', expected: undefined },
      { input: '2026-02-29T00:00:00Z', expected: undefined },
      { input: '2026-13-01T00:00:00Z', expected: undefined },
      { input: '2026-12-01T24:00:00Z', expected: undefined },
      { input: '2026-12-01T00:00:00+24:00', expected: undefined },
    ];
    for (const c of cases) {
      it(`parses ${c.input}`, () => {
        expect(parseRfc3339(c.input)).to.equal(c.expected);
      });
    }

    it('accepts expiresAt timestamps the relayer accepts', () => {
      const rules = parseDenylistFile(
        rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            expiresAt: '2026-12-01 00:00:00z',
            address: TX_SENDER,
          },
        ]),
      );

      expect(rules.addressRules[0].expiresAt).to.equal(1796083200000);
    });
  });

  describe('parseDenylistFile', () => {
    it('accepts the live registry denylist, including matchBody rules', () => {
      const text = readFileSync(
        new URL('./fixtures/mainnet-denylist.json', import.meta.url),
        'utf8',
      );

      const rules = parseDenylistFile(text);

      expect(rules.matchRules).to.have.lengthOf(438);
      expect(rules.addressRules).to.have.lengthOf(33);

      const bodyAddresses = rules.addressRules
        .map((rule) => rule.bodyAddress)
        .filter((address) => address !== undefined);

      expect(bodyAddresses).to.have.lengthOf(7);
      expect(bodyAddresses).to.include(
        'a0e768a68ba1bfffb9f4366dfc8d9195ee7217d1',
      );
    });

    interface InvalidFileCase {
      name: string;
      text: string;
      failure: DenylistLoadFailure;
      message: RegExp;
    }
    const invalidCases: InvalidFileCase[] = [
      {
        name: 'non-JSON',
        text: '{',
        failure: DenylistLoadFailure.InvalidFile,
        message: /^Invalid denylist JSON/,
      },
      {
        name: 'missing rules',
        text: '{}',
        failure: DenylistLoadFailure.InvalidFile,
        message: /^file: rules:/,
      },
      {
        name: 'unknown top-level key',
        text: JSON.stringify({ rules: [], extra: 1 }),
        failure: DenylistLoadFailure.InvalidFile,
        message: /Unrecognized key: "extra"/,
      },
      {
        name: 'both match and address',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { messageId: MESSAGE_ID },
            address: TX_SENDER,
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /Exactly one of `match` or `address` must be set/,
      },
      {
        name: 'empty reason',
        text: rulesFile([{ reason: ' ', addedBy: 'a', address: TX_SENDER }]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`reason` must not be empty/,
      },
      {
        name: 'invalid expiresAt',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', expiresAt: 'soon', address: TX_SENDER },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message:
          /^Invalid denylist rule at index 0: rule: expiresAt: `expiresAt` must be an RFC 3339 timestamp/,
      },
      {
        name: 'wildcard-only match',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { originDomain: '*' } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`match` must set messageId/,
      },
      {
        name: 'empty list',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { originDomain: [] } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /match.originDomain is an empty list/,
      },
      {
        name: 'unknown match field',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { nonce: 1, originDomain: 1 } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /Unknown `match` field `nonce`/,
      },
      {
        name: 'conflicting match aliases',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 1, origindomain: 2 },
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /Conflicting `match` aliases for `origindomain`/,
      },
      {
        name: 'a 20-byte zero address',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            address: '0x0000000000000000000000000000000000000000',
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`address` must not be zero/,
      },
      {
        name: 'a 32-byte zero address',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            address: ZERO_ADDRESS_HEX_32,
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`address` must not be zero/,
      },
      {
        name: 'bad Tron checksum in match',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { senderAddress: [TRON_ADDRESS_BAD_CHECKSUM] },
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /failed its prefix or checksum check/,
      },
      {
        name: 'matchBody on a match rule',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 1 },
            matchBody: false,
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`matchBody` is only valid on an `address` rule/,
      },
      {
        name: 'a non-boolean matchBody',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', address: TX_SENDER, matchBody: 'true' },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /^Invalid denylist rule at index 0: rule: matchBody: /,
      },
      {
        name: 'matchBody on a 32-byte hex address',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            address: MESSAGE_ID,
            matchBody: true,
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`matchBody` requires a 20-byte EVM hex address/,
      },
      {
        name: 'matchBody on a Tron address',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            address: TRON_ADDRESS,
            matchBody: true,
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`matchBody` requires a 20-byte EVM hex address/,
      },
      {
        name: 'an empty bodyRegex alone',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { bodyRegex: '' } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`match` must set messageId/,
      },
      {
        name: 'a match-all bodyRegex alone',
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { bodyRegex: '.*' } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /`match` must set messageId/,
      },
      {
        name: 'a bodyRegex that does not compile',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 1, bodyRegex: '(' },
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /match.bodyRegex is not a valid regex/,
      },
      ...[
        ['a digit escape', 'a\\0'],
        ['a digit escape in a class', '[\\0]'],
        ['a backreference', '(ab)\\1'],
        ['a quoted sequence', '\\Q.\\E'],
        ['a start-of-word escape', '\\<a'],
        ['an end-of-word escape', 'a\\>'],
        ['a word boundary with braces', '\\b{start}'],
        ['a non-word boundary with braces', '\\B{x}'],
        ['a count without a minimum', 'a{,3}'],
        ['a count with a space', 'a{ 2}'],
        ['a count with a leading zero', 'a{02}'],
        ['an unclosed brace', 'a{'],
        ['a group name starting with a digit', '(?P<1n>a)'],
        ['a short group name starting with a digit', '(?<1n>a)'],
        ['a quantifier after a flag group', '(?i)*'],
        ['a count after a flag group', '(?i){2}'],
        ['a class intersection', '[a-f&&b-f]'],
        ['the mainnet prefix with a class intersection', '^0{24}[a-f&&b-f]'],
        ['a class difference', '[a-f--b]'],
        ['a class symmetric difference', '[a-f~~b]'],
        ['a nested class', '[[a-c]d]'],
        ['a range ending in a class', '[ -[:alpha:]]'],
        ['a range starting at an escaped class', '[\\d-z]'],
        ['a range starting at a braced Unicode class', '[\\p{L}-z]'],
        ['groups nested 61 deep', `${'('.repeat(61)}a${')'.repeat(61)}`],
        ['a surrogate escape', '\\x{d800}'],
        ['the last surrogate', '\\x{dfff}'],
        ['an uppercase surrogate escape', '\\x{D800}'],
        ['a surrogate range end', '[a-\\x{d8c1}]'],
        ['a negated Unicode property', '\\p{^Greek}'],
        ['a negated Unicode property in a class', '[\\P{^L}]'],
      ].map(([syntax, bodyRegex]) => ({
        name: `a bodyRegex with ${syntax}`,
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { originDomain: 1, bodyRegex } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message:
          /syntax the relayer's regex engine rejects or reads differently/,
      })),
      ...[
        ['lookahead', '(?=ab)ab'],
        ['lookbehind', '(?<=a)b'],
        ['negative lookbehind', '(?<!a)b'],
        ['a named backreference', '(?<n>a)\\k<n>'],
        ['a control escape', '\\cA'],
        ['an unclosed class opened by ]', '[]a'],
        ['an unclosed negated class opened by ]', '[^]'],
        ['a braced Unicode escape', '\\u{41}'],
        ['the verbose flag', '(?x) a'],
        ['stacked quantifiers', 'a**'],
        ['a quantifier after a count', 'a{2}*'],
        ['a count above 1000', 'a{1001}'],
      ].map(([syntax, bodyRegex]) => ({
        name: `a bodyRegex with ${syntax}`,
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { originDomain: 1, bodyRegex } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /match.bodyRegex is not a valid regex/,
      })),
      ...[
        ['a non-digit class past the relayer size limit', '\\D{900}'],
        ['a word class past the relayer size limit', '\\w{220}'],
        ['repeats adding up past the relayer size limit', '\\w{150}\\w{150}'],
        ['a repeated group past the relayer size limit', '(?:\\w{50}){5}'],
        ['a negated digit class past the relayer size limit', '[^\\d]{900}'],
        [
          'negated space classes adding up past the relayer size limit',
          '[^\\s]{1000}'.repeat(6),
        ],
        [
          'negated literal classes adding up past the relayer size limit',
          '[^\\x{10000}]{1000}'.repeat(10),
        ],
        [
          'case-folded negated ranges adding up past the relayer size limit',
          '(?i)[^\\x{1e00}-\\x{a7ff}]{1000}'.repeat(3),
        ],
        [
          'a negated class of 1000 members past the relayer size limit',
          `[^${Array.from({ length: 1000 }, (_, i) => `\\x{${(0xe000 + 97 * i).toString(16)}}`).join('')}]{100}`,
        ],
        [
          'a repeated group past the conservative size estimate',
          '(?:\\w{51})+',
        ],
        [
          'an open-ended count past the conservative size estimate',
          '\\w{100,}',
        ],
        ['alternatives past the conservative size estimate', '\\w{60}|\\w{60}'],
      ].map(([syntax, bodyRegex]) => ({
        name: `a bodyRegex with ${syntax}`,
        text: rulesFile([
          { reason: 'r', addedBy: 'a', match: { originDomain: 1, bodyRegex } },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /may exceed the relayer's regex size limit/,
      })),
      {
        name: 'a non-string bodyRegex',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 1, bodyRegex: 1 },
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /match.bodyRegex: /,
      },
      {
        name: 'conflicting bodyRegex aliases',
        text: rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 1, bodyRegex: '\\D', BODYREGEX: '\\d' },
          },
        ]),
        failure: DenylistLoadFailure.InvalidFile,
        message: /Conflicting `match` aliases for `bodyregex`/,
      },
    ];
    for (const c of invalidCases) {
      it(`rejects the whole file on ${c.name}`, () => {
        const error = captureLoadError(c.text);

        expect(error.failure).to.equal(c.failure);
        expect(error.message).to.match(c.message);
      });
    }

    const acceptedBodyRegexes: Array<[string, string]> = [
      ['a named group', '(?<n>ab)'],
      ['a P-named group', '(?P<n>ab)'],
      ['a group name starting with _', '(?<_n>a)'],
      ['an escaped parenthesis before ?=', '\\(?=a'],
      ['(?= inside a class', '[(?=]'],
      ['a class with a trailing dash', '[a-]'],
      ['a class with a leading dash', '[-a]'],
      ['an escaped class before a trailing dash', '[\\d-]'],
      ['a POSIX class before a range dash', '[[:alpha:]-z]'],
      ['a POSIX class', '[[:alpha:]]'],
      ['a negated POSIX class', '[[:^digit:]]'],
      ['a class opened by ]', '[]a]'],
      ['an inline flag', '(?i)ab'],
      ['text anchors', '\\Aab\\z'],
      ['an escaped dash', '\\-'],
      ['an open-ended count', 'a{2,}'],
      ['a zero count', 'a{0}'],
      ['a count after a braced Unicode class', '\\p{L}{2}'],
      ['a count after a braced hex escape', '\\x{61}{2}'],
      ['groups nested 60 deep', `${'('.repeat(60)}a${')'.repeat(60)}`],
      ['a range across the surrogates', '[\\x{d000}-\\x{e000}]'],
      ['the code point before the surrogates', '\\x{d7ff}'],
      ['a word class repeated 100 times', '\\w{100}'],
      ['a hex class repeated 1000 times', '[0-9a-f]{1000}'],
      ['the mainnet recipient prefix', '^0{24}[0-9a-f]{40}'],
      ['a repeated group at the size estimate', '(?:\\w{50})+'],
      ['an open-ended count at the size estimate', '\\w{99,}'],
      ['alternatives at the size estimate', '\\w{50}|\\w{50}'],
      ['a lazy count at the size estimate', '\\w{100}?'],
    ];
    for (const [syntax, bodyRegex] of acceptedBodyRegexes) {
      it(`accepts a bodyRegex with ${syntax}`, () => {
        const rules = parseDenylistFile(
          rulesFile([
            {
              reason: 'r',
              addedBy: 'a',
              match: { originDomain: 1, bodyRegex },
            },
          ]),
        );

        expect(rules.matchRules[0].bodyRegex?.pattern()).to.equal(bodyRegex);
      });
    }

    it('rejects the whole file when an unrelated rule exceeds the relayer size limit', () => {
      const error = captureLoadError(
        rulesFile([
          {
            reason: 'r',
            addedBy: 'a',
            match: { originDomain: 999, bodyRegex: '\\D{900}' },
          },
          { reason: 'r', addedBy: 'a', match: { messageId: MESSAGE_ID } },
        ]),
      );

      expect(error.failure).to.equal(DenylistLoadFailure.InvalidFile);
      expect(error.message).to.match(
        /may exceed the relayer's regex size limit/,
      );
    });

    it('reports the index of the first invalid rule', () => {
      const error = captureLoadError(
        rulesFile([
          { reason: 'r', addedBy: 'a', match: { messageId: MESSAGE_ID } },
          { reason: 'r', addedBy: 'a', address: 'nope' },
        ]),
      );

      expect(error.failure).to.equal(DenylistLoadFailure.InvalidFile);
      expect(error.message).to.match(/^Invalid denylist rule at index 1: /);
    });
  });

  describe('findDenyReason', () => {
    interface MatchCase {
      name: string;
      rule: Record<string, unknown>;
      message: ExplorerMessage;
      denied: boolean;
    }
    const cases: MatchCase[] = [
      {
        name: 'messageId rule matches its message',
        rule: { match: { messageId: MESSAGE_ID } },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'messageId rule matches case-insensitively',
        rule: {
          match: { messageId: MESSAGE_ID.toUpperCase().replace('0X', '0x') },
        },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'messageId rule ignores other messages',
        rule: { match: { messageId: MESSAGE_ID } },
        message: buildMessage({ msg_id: OTHER_MESSAGE_ID }),
        denied: false,
      },
      {
        name: 'domain and address rule matches when every field matches',
        rule: {
          match: {
            originDomain: 42161,
            senderAddress: [UNRELATED_ADDRESS, ORIGIN_ROUTER],
            destinationDomain: '1',
            recipientAddress: [DESTINATION_ROUTER],
          },
        },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'domain and address rule ignores a different destination',
        rule: {
          match: {
            originDomain: 42161,
            senderAddress: [ORIGIN_ROUTER],
            destinationDomain: 8453,
            recipientAddress: [DESTINATION_ROUTER],
          },
        },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: false,
      },
      {
        name: 'match keys are case-insensitive',
        rule: { match: { DESTINATIONDOMAIN: [1], recipientaddress: '*' } },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'address rule matches the message sender',
        rule: { address: ORIGIN_ROUTER },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'address rule matches the message recipient',
        rule: { address: DESTINATION_ROUTER },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'address rule matches the warp transfer recipient',
        rule: { address: WARP_RECIPIENT },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'address rule matches the origin tx sender',
        rule: { address: TX_SENDER },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'address rule matches a 32-byte Solana sender',
        rule: { address: SOLANA_ADDRESS },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          sender:
            '0x8fa155f74d49e7464faa0d27041225f2ec5b8a5632fc68efb022d57946ec19c9',
        }),
        denied: true,
      },
      {
        name: 'address rule matches a Tron origin tx sender',
        rule: { address: TRON_ADDRESS },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          origin_tx_sender: '0x430b9b4a60d18affe500b731a97b5aa622c7863f',
        }),
        denied: true,
      },
      {
        name: 'address rule does not scan the rest of the body',
        rule: { address: UNRELATED_ADDRESS },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x${'00'.repeat(32)}${UNRELATED_ADDRESS.slice(2)}`,
        }),
        denied: false,
      },
      {
        name: 'bodyRegex with mixed-case keys matches the hex body unanchored',
        rule: {
          match: {
            MeSsAgEiD: MESSAGE_ID,
            ORIGINDOMAIN: 42161,
            DestinationDomain: 1,
            BodyRegex: '^a\\D$',
          },
        },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xab' }),
        denied: true,
      },
      {
        name: 'bodyRegex rule ignores a body that does not match',
        rule: { match: { originDomain: 42161, bodyRegex: '^a\\D$' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xa1' }),
        denied: false,
      },
      {
        name: 'bodyRegex must match together with the other fields',
        rule: { match: { originDomain: 1, bodyRegex: 'ab' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xab' }),
        denied: false,
      },
      {
        name: 'bodyRegex matches a lowercase body without 0x',
        rule: { match: { destinationDomain: 1, bodyRegex: '^ab$' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xAB' }),
        denied: true,
      },
      {
        name: 'bodyRegex matches a substring of the body',
        rule: { match: { destinationDomain: 1, bodyRegex: 'bc' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xabcd' }),
        denied: true,
      },
      {
        name: 'a 20-byte zero match.senderAddress matches the zero sender',
        rule: {
          match: {
            senderAddress: '0x0000000000000000000000000000000000000000',
          },
        },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          sender: ZERO_ADDRESS_HEX_32,
        }),
        denied: true,
      },
      {
        name: 'a 20-byte zero match.recipientAddress matches the zero recipient',
        rule: {
          match: {
            recipientAddress: '0x0000000000000000000000000000000000000000',
          },
        },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          recipient: ZERO_ADDRESS_HEX_32,
        }),
        denied: true,
      },
      {
        name: 'a 20-byte zero match.messageId matches the zero message id',
        rule: {
          match: { messageId: '0x0000000000000000000000000000000000000000' },
        },
        message: buildMessage({ msg_id: ZERO_ADDRESS_HEX_32 }),
        denied: true,
      },
      {
        name: 'a null bodyRegex is no constraint',
        rule: { match: { messageId: MESSAGE_ID, bodyRegex: null } },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
      {
        name: 'bodyRegex honours an inline case-insensitive flag',
        rule: { match: { destinationDomain: 1, bodyRegex: '(?i)^AB$' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xab' }),
        denied: true,
      },
      {
        name: 'bodyRegex matches between text anchors',
        rule: { match: { destinationDomain: 1, bodyRegex: '\\Aab\\z' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xab' }),
        denied: true,
      },
      {
        name: 'bodyRegex text anchors reject a longer body',
        rule: { match: { destinationDomain: 1, bodyRegex: '\\Aab\\z' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xabab' }),
        denied: false,
      },
      {
        name: 'bodyRegex matches through a P-named group',
        rule: { match: { destinationDomain: 1, bodyRegex: '^(?P<n>ab)cd$' } },
        message: buildMessage({ msg_id: MESSAGE_ID, message_body: '0xabcd' }),
        denied: true,
      },
      {
        name: 'the mainnet relayer bodyRegex matches its message',
        rule: {
          match: { destinationDomain: 1, bodyRegex: MAINNET_BODY_REGEX },
        },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x${MAINNET_BODY_PREFIX}${'00'.repeat(32)}`,
        }),
        denied: true,
      },
      {
        name: 'the mainnet relayer bodyRegex ignores another message',
        rule: {
          match: { destinationDomain: 1, bodyRegex: MAINNET_BODY_REGEX },
        },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x02${MAINNET_BODY_PREFIX.slice(2)}${'00'.repeat(32)}`,
        }),
        denied: false,
      },
      {
        name: 'matchBody rule finds the address anywhere in the body',
        rule: { address: BODY_ADDRESS, matchBody: true },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x${'00'.repeat(45)}${BODY_ADDRESS.slice(2).toLowerCase()}${'00'.repeat(3)}`,
        }),
        denied: true,
      },
      {
        name: 'matchBody rule ignores the address off a byte boundary',
        rule: { address: BODY_ADDRESS, matchBody: true },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x${'00'.repeat(45)}0${BODY_ADDRESS.slice(2).toLowerCase()}0${'00'.repeat(3)}`,
        }),
        denied: false,
      },
      {
        name: 'matchBody false does not scan the body',
        rule: { address: BODY_ADDRESS, matchBody: false },
        message: buildMessage({
          msg_id: MESSAGE_ID,
          message_body: `0x${'00'.repeat(45)}${BODY_ADDRESS.slice(2).toLowerCase()}${'00'.repeat(3)}`,
        }),
        denied: false,
      },
      {
        name: 'expired rule is ignored',
        rule: {
          expiresAt: '2026-11-03T23:59:59Z',
          match: { messageId: MESSAGE_ID },
        },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: false,
      },
      {
        name: 'rule expiring exactly now is ignored',
        rule: { expiresAt: '2026-11-04T00:00:00Z', address: TX_SENDER },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: false,
      },
      {
        name: 'rule expiring later is active',
        rule: {
          expiresAt: '2026-11-05T00:00:00+01:00',
          match: { messageId: MESSAGE_ID },
        },
        message: buildMessage({ msg_id: MESSAGE_ID }),
        denied: true,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const rules = parseDenylistFile(
          rulesFile([
            {
              reason: BASE_RULE.reason,
              addedBy: BASE_RULE.addedBy,
              expiresAt: c.rule.expiresAt,
              match: c.rule.match,
              address: c.rule.address,
              matchBody: c.rule.matchBody,
            },
          ]),
        );

        const reason = findDenyReason(rules, c.message, NOW);

        expect(reason).to.equal(
          c.denied ? 'test (added by tester)' : undefined,
        );
      });
    }

    it('matches a bodyRegex in linear time', () => {
      const rules = parseDenylistFile(
        rulesFile([
          {
            reason: BASE_RULE.reason,
            addedBy: BASE_RULE.addedBy,
            match: { destinationDomain: 1, bodyRegex: '(0+)+1$' },
          },
        ]),
      );
      const message = buildMessage({
        msg_id: MESSAGE_ID,
        message_body: `0x${'00'.repeat(64)}`,
      });

      const start = performance.now();
      const reason = findDenyReason(rules, message, NOW);

      expect(performance.now() - start).to.be.lessThan(1000);
      expect(reason).to.equal(undefined);
    });
  });
});
