import {
  address as parseAddress,
  getAddressEncoder,
  type Address,
} from '@solana/kit';
import { expect } from 'chai';
import { describe, it } from 'mocha';

import { assert, ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { encodeValidatorsAndThreshold } from '../codecs/shared.js';
import {
  deriveMultisigIsmAccessControlPda,
  deriveMultisigIsmDomainDataPda,
} from '../pda.js';

import {
  decodeRoutingMultisigAccounts,
  type RoutingMultisigAccount,
} from './routing-multisig-reader.js';

const PROGRAM_ID: Address = parseAddress(
  '2gqSMt66ZABt82TTQgrdxf7tJ4eQpLuYj6N29ieBQrH2',
);
const OWNER = parseAddress('zUeFx6cfxedG2JnFtMKkTXnxgPa5M44tyaF9RrPunCp');

const VALIDATOR_1 = '0x1111111111111111111111111111111111111111';
const VALIDATOR_2 = '0x2222222222222222222222222222222222222222';
const VALIDATOR_3 = '0x3333333333333333333333333333333333333333';

const addressEncoder = getAddressEncoder();

function buildAccessControlData(
  bump: number,
  owner: Address | null,
): Uint8Array {
  const ownerBytes =
    owner === null
      ? new Uint8Array([0])
      : Uint8Array.from([1, ...addressEncoder.encode(owner)]);
  return Uint8Array.from([1, bump, ...ownerBytes]);
}

function buildDomainData(
  bump: number,
  validators: string[],
  threshold: number,
): Uint8Array {
  const payload = encodeValidatorsAndThreshold({
    validators: validators.map((v) => {
      const hex = v.startsWith('0x') ? v.slice(2) : v;
      assert(
        /^[0-9a-fA-F]{40}$/.test(hex),
        `Expected 20-byte hex validator, got ${v}`,
      );
      const out = new Uint8Array(20);
      for (let i = 0; i < 20; i += 1) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }),
    threshold,
  });
  return Uint8Array.from([1, bump, ...payload]);
}

interface DomainFixture {
  domain: number;
  validators: string[];
  threshold: number;
}

interface ReaderCase {
  name: string;
  hasAccessControl: boolean;
  accessOwner: Address | null;
  domainFixtures: DomainFixture[];
  candidateDomains: number[];
  /** Pubkey for an extra account that should NOT match any candidate. */
  includeUnknownAccount: boolean;
  expectedOwnerCheck: (owner: string) => void;
  expectedDomains: number[];
  expectedUnmatchedCount: number;
}

const cases: ReaderCase[] = [
  {
    name: 'access-control only — empty domains map',
    hasAccessControl: true,
    accessOwner: OWNER,
    domainFixtures: [],
    candidateDomains: [],
    includeUnknownAccount: false,
    expectedOwnerCheck: (owner) => expect(owner).to.equal(OWNER),
    expectedDomains: [],
    expectedUnmatchedCount: 0,
  },
  {
    name: 'one configured domain in candidates',
    hasAccessControl: true,
    accessOwner: OWNER,
    domainFixtures: [
      {
        domain: 1,
        validators: [VALIDATOR_1, VALIDATOR_2, VALIDATOR_3],
        threshold: 2,
      },
    ],
    candidateDomains: [1, 137, 8453],
    includeUnknownAccount: false,
    expectedOwnerCheck: (owner) => expect(owner).to.equal(OWNER),
    expectedDomains: [1],
    expectedUnmatchedCount: 0,
  },
  {
    name: 'multiple configured domains all in candidates',
    hasAccessControl: true,
    accessOwner: OWNER,
    domainFixtures: [
      {
        domain: 1,
        validators: [VALIDATOR_1, VALIDATOR_2],
        threshold: 1,
      },
      {
        domain: 137,
        validators: [VALIDATOR_3],
        threshold: 1,
      },
    ],
    candidateDomains: [1, 137],
    includeUnknownAccount: false,
    expectedOwnerCheck: (owner) => expect(owner).to.equal(OWNER),
    expectedDomains: [1, 137],
    expectedUnmatchedCount: 0,
  },
  {
    name: 'unmatched account ignored — surfaced via unmatchedDomainAccounts',
    hasAccessControl: true,
    accessOwner: OWNER,
    domainFixtures: [{ domain: 1, validators: [VALIDATOR_1], threshold: 1 }],
    candidateDomains: [1],
    includeUnknownAccount: true,
    expectedOwnerCheck: (owner) => expect(owner).to.equal(OWNER),
    expectedDomains: [1],
    expectedUnmatchedCount: 1,
  },
  {
    name: 'null owner — surfaces ZERO_ADDRESS_HEX_32 fallback (matches IGP/warp readers)',
    hasAccessControl: true,
    accessOwner: null,
    domainFixtures: [],
    candidateDomains: [],
    includeUnknownAccount: false,
    expectedOwnerCheck: (owner) => expect(owner).to.equal(ZERO_ADDRESS_HEX_32),
    expectedDomains: [],
    expectedUnmatchedCount: 0,
  },
];

describe('decodeRoutingMultisigAccounts', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const accounts: RoutingMultisigAccount[] = [];

      if (c.hasAccessControl) {
        const { address: accessPda, bump } =
          await deriveMultisigIsmAccessControlPda(PROGRAM_ID);
        accounts.push({
          pubkey: accessPda,
          data: buildAccessControlData(bump, c.accessOwner),
        });
      }

      for (const fixture of c.domainFixtures) {
        const { address: pda, bump } = await deriveMultisigIsmDomainDataPda(
          PROGRAM_ID,
          fixture.domain,
        );
        accounts.push({
          pubkey: pda,
          data: buildDomainData(bump, fixture.validators, fixture.threshold),
        });
      }

      if (c.includeUnknownAccount) {
        // Use a fixed non-PDA pubkey; the helper must reject it.
        accounts.push({
          pubkey: parseAddress('11111111111111111111111111111112'),
          data: buildDomainData(255, [VALIDATOR_1], 1),
        });
      }

      const result = await decodeRoutingMultisigAccounts(
        PROGRAM_ID,
        accounts,
        c.candidateDomains,
      );

      const owner = result.accessControl.owner ?? ZERO_ADDRESS_HEX_32;
      c.expectedOwnerCheck(owner);

      const decodedDomains = Object.keys(result.domains)
        .map((d) => Number(d))
        .sort((a, b) => a - b);
      expect(decodedDomains).to.deep.equal(c.expectedDomains);

      expect(result.unmatchedDomainAccounts).to.have.length(
        c.expectedUnmatchedCount,
      );

      for (const fixture of c.domainFixtures) {
        if (!c.expectedDomains.includes(fixture.domain)) continue;
        const child = result.domains[fixture.domain];
        expect(child.config.type).to.equal('messageIdMultisigIsm');
        if (child.config.type !== 'messageIdMultisigIsm') return;
        expect(child.config.threshold).to.equal(fixture.threshold);
        expect(child.config.validators).to.have.length(
          fixture.validators.length,
        );
      }
    });
  }

  it('throws when access-control PDA is missing from accounts', async () => {
    let caught: unknown;
    try {
      await decodeRoutingMultisigAccounts(PROGRAM_ID, [], []);
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof Error, 'expected Error to be thrown');
    expect(caught.message).to.include('access-control PDA missing');
  });
});
