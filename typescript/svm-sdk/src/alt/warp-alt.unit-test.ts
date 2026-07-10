import { type Address, address } from '@solana/kit';
import { expect } from 'chai';
import sinon from 'sinon';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type FeeArtifactConfig,
  type FeeReadContext,
  FeeParamsType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN, WILDCARD_SENDER } from '../codecs/igp.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { DEFAULT_FEE_SALT } from '../fee/types.js';
import { DEFAULT_IGP_SALT, deriveIgpSalt } from '../hook/igp-hook.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveIgpQuoteAuthorityPda,
  deriveIgpStandingQuotePda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';

import { SvmAddressLookupTableWriter } from './address-lookup-table.js';
import {
  type AnnotatedAltAddress,
  createWarpAltsImpl,
  deriveCoreDeploymentAltAddresses,
  deriveFeeQuoteCascadeAltAddresses,
  deriveIgpQuoteCascadeAltAddresses,
  diffBucket,
} from './warp-alt.js';

function addressesOf(entries: readonly AnnotatedAltAddress[]): Address[] {
  return entries.map((e) => e.address);
}

const MAILBOX: Address = address(
  'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
);
const IGP_PROGRAM: Address = address(
  'BCYqLqWsXmA3sP7VBR1G64rUQXqXM6JzkqpYxbFv5Yu1',
);
const ALT_IGP_SALT = deriveIgpSalt('warp-alt-test:alt-salt');

function isSortedAscending<T extends string>(items: T[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1]! >= items[i]!) return false;
  }
  return true;
}

describe('deriveCoreDeploymentAltAddresses', () => {
  it('returns sdk constants + mailbox/outbox without igp', async () => {
    const outbox = (await deriveMailboxOutboxPda(MAILBOX)).address;
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX);

    expect(result).to.have.lengthOf(5);
    expect(new Set(addressesOf(result))).to.deep.equal(
      new Set([
        SYSTEM_PROGRAM_ADDRESS,
        SPL_NOOP_PROGRAM_ADDRESS,
        SPL_TOKEN_PROGRAM_ADDRESS,
        MAILBOX,
        outbox,
      ]),
    );
  });

  it('annotates the constant entries with their semantic role', async () => {
    const outbox = (await deriveMailboxOutboxPda(MAILBOX)).address;
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX);

    const byAddress = new Map(result.map((e) => [e.address, e.description]));
    expect(byAddress.get(SYSTEM_PROGRAM_ADDRESS)).to.equal('system_program');
    expect(byAddress.get(SPL_NOOP_PROGRAM_ADDRESS)).to.equal('spl_noop');
    expect(byAddress.get(SPL_TOKEN_PROGRAM_ADDRESS)).to.equal(
      'spl_token_program',
    );
    expect(byAddress.get(MAILBOX)).to.equal('mailbox');
    expect(byAddress.get(outbox)).to.equal('mailbox.outbox');
  });

  it('adds igp program + program data + igp account when igp ctx supplied', async () => {
    const programData = (await deriveIgpProgramDataPda(IGP_PROGRAM)).address;
    const igpAccount = (
      await deriveIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT)
    ).address;

    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
    });

    expect(result).to.have.lengthOf(8);
    expect(addressesOf(result)).to.include.members([
      IGP_PROGRAM,
      programData,
      igpAccount,
    ]);

    const byAddress = new Map(result.map((e) => [e.address, e.description]));
    expect(byAddress.get(IGP_PROGRAM)).to.equal('igp.program');
    expect(byAddress.get(programData)).to.equal('igp.program_data');
    expect(byAddress.get(igpAccount)).to.equal('igp.account');
  });

  it('adds overhead-igp account when includeOverheadIgp is set', async () => {
    const overhead = (
      await deriveOverheadIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT)
    ).address;

    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
      includeOverheadIgp: true,
    });

    expect(result).to.have.lengthOf(9);
    expect(addressesOf(result)).to.include(overhead);

    const byAddress = new Map(result.map((e) => [e.address, e.description]));
    expect(byAddress.get(overhead)).to.equal('igp.overhead_account');
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
      includeOverheadIgp: true,
    });
    const addresses = addressesOf(result);

    expect(isSortedAscending([...addresses])).to.equal(
      true,
      `expected ascending order, got: ${addresses.join(', ')}`,
    );
    expect(new Set(addresses).size).to.equal(addresses.length);
  });

  it('different igp salts produce different igp account entries', async () => {
    const a = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
    });
    const b = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: ALT_IGP_SALT,
    });

    const aSet = new Set(addressesOf(a));
    const bSet = new Set(addressesOf(b));
    const onlyInA = [...aSet].filter((addr) => !bSet.has(addr));
    const onlyInB = [...bSet].filter((addr) => !aSet.has(addr));

    expect(
      onlyInA,
      'expected exactly one address unique to set A',
    ).to.have.lengthOf(1);
    expect(
      onlyInB,
      'expected exactly one address unique to set B',
    ).to.have.lengthOf(1);
  });
});

const FEE_PROGRAM: Address = address(
  'F33ip6ZJ4LQHxq3sJTbxsZNG6tWELzETSdpMmFwGV4tT',
);
const ROUTER_A_HEX = `0x${'aa'.repeat(32)}`;
const ROUTER_B_HEX = `0x${'bb'.repeat(32)}`;
const ROUTER_A_BYTES = Uint8Array.from({ length: 32 }, () => 0xaa);

const BASE_FEE_CONFIG = {
  owner: '0x0000000000000000000000000000000000000000',
  beneficiary: '0x0000000000000000000000000000000000000000',
} as const;

function leafFeeConfig(): FeeArtifactConfig {
  return {
    type: FeeType.linear,
    ...BASE_FEE_CONFIG,
    params: {
      type: FeeParamsType.raw,
      maxFee: '1',
      halfAmount: '1',
    },
  };
}

function routingFeeConfig(): FeeArtifactConfig {
  return {
    type: FeeType.routing,
    ...BASE_FEE_CONFIG,
    routes: {},
  };
}

function ccFeeConfig(): FeeArtifactConfig {
  return {
    type: FeeType.crossCollateralRouting,
    ...BASE_FEE_CONFIG,
    routes: {},
  };
}

function feeContext(
  knownRoutersPerDomain: Record<number, Set<string>>,
): FeeReadContext {
  return { knownRoutersPerDomain };
}

describe('deriveFeeQuoteCascadeAltAddresses', () => {
  let FEE_ACCOUNT: Address;

  before(async () => {
    const pda = await deriveFeeAccountPda(FEE_PROGRAM, DEFAULT_FEE_SALT);
    FEE_ACCOUNT = pda.address;
  });

  describe('Leaf variants (linear / regressive / progressive / offchainQuoted)', () => {
    it('returns fee program + fee account + wildcard standing when no domains are enrolled', async () => {
      const wildcard = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        WILDCARD_DOMAIN,
        H256_ZERO,
      );

      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeSalt: DEFAULT_FEE_SALT,
        feeConfig: leafFeeConfig(),
        feeReadContext: feeContext({}),
      });

      expect(new Set(addressesOf(result))).to.deep.equal(
        new Set([FEE_PROGRAM, FEE_ACCOUNT, wildcard.address]),
      );

      const byAddress = new Map(result.map((e) => [e.address, e.description]));
      expect(byAddress.get(FEE_PROGRAM)).to.equal('fee.program');
      expect(byAddress.get(FEE_ACCOUNT)).to.equal('fee.account');
      expect(byAddress.get(wildcard.address)).to.equal(
        'fee.standing_quote(domain=wildcard)',
      );
    });

    it('adds standing pda per enrolled domain plus the wildcard', async () => {
      const standingA = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        H256_ZERO,
      );
      const standingB = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        20,
        H256_ZERO,
      );
      const wildcard = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        WILDCARD_DOMAIN,
        H256_ZERO,
      );

      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeSalt: DEFAULT_FEE_SALT,
        feeConfig: leafFeeConfig(),
        feeReadContext: feeContext({
          10: new Set([ROUTER_A_HEX]),
          20: new Set([ROUTER_B_HEX]),
        }),
      });

      expect(new Set(addressesOf(result))).to.deep.equal(
        new Set([
          FEE_PROGRAM,
          FEE_ACCOUNT,
          standingA.address,
          standingB.address,
          wildcard.address,
        ]),
      );

      const byAddress = new Map(result.map((e) => [e.address, e.description]));
      expect(byAddress.get(standingA.address)).to.equal(
        'fee.standing_quote(domain=10)',
      );
      expect(byAddress.get(standingB.address)).to.equal(
        'fee.standing_quote(domain=20)',
      );
    });
  });

  describe('Routing variant', () => {
    it('adds route_pda per enrolled domain on top of the leaf cascade', async () => {
      const standing = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        H256_ZERO,
      );
      const wildcard = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        WILDCARD_DOMAIN,
        H256_ZERO,
      );
      const route = await deriveRouteDomainPda(FEE_PROGRAM, FEE_ACCOUNT, 10);

      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeSalt: DEFAULT_FEE_SALT,
        feeConfig: routingFeeConfig(),
        feeReadContext: feeContext({ 10: new Set([ROUTER_A_HEX]) }),
      });

      expect(new Set(addressesOf(result))).to.deep.equal(
        new Set([
          FEE_PROGRAM,
          FEE_ACCOUNT,
          standing.address,
          wildcard.address,
          route.address,
        ]),
      );

      const byAddress = new Map(result.map((e) => [e.address, e.description]));
      expect(byAddress.get(route.address)).to.equal('fee.route(domain=10)');
    });
  });

  describe('CrossCollateralRouting variant', () => {
    it('includes specific + default route + standing pdas per (domain, target_router) pair', async () => {
      const ccRouteA = await deriveCrossCollateralRoutePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        ROUTER_A_BYTES,
      );
      const ccRouteDefault = await deriveCrossCollateralRoutePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        DEFAULT_ROUTER,
      );
      const standingA = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        ROUTER_A_BYTES,
      );
      const standingDefault = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        DEFAULT_ROUTER,
      );
      const wildcardA = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        WILDCARD_DOMAIN,
        ROUTER_A_BYTES,
      );

      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeSalt: DEFAULT_FEE_SALT,
        feeConfig: ccFeeConfig(),
        feeReadContext: feeContext({ 10: new Set([ROUTER_A_HEX]) }),
      });

      expect(new Set(addressesOf(result))).to.deep.equal(
        new Set([
          FEE_PROGRAM,
          FEE_ACCOUNT,
          ccRouteA.address,
          ccRouteDefault.address,
          standingA.address,
          standingDefault.address,
          wildcardA.address,
        ]),
      );

      const byAddress = new Map(result.map((e) => [e.address, e.description]));
      expect(byAddress.get(ccRouteDefault.address)).to.equal(
        'fee.cc_route(domain=10, target_router=DEFAULT)',
      );
      expect(byAddress.get(standingDefault.address)).to.equal(
        'fee.cc_standing_quote(domain=10, target_router=DEFAULT)',
      );
      expect(byAddress.get(ccRouteA.address)).to.equal(
        `fee.cc_route(domain=10, target_router=${ROUTER_A_HEX})`,
      );
      expect(byAddress.get(standingA.address)).to.equal(
        `fee.cc_standing_quote(domain=10, target_router=${ROUTER_A_HEX})`,
      );
      expect(byAddress.get(wildcardA.address)).to.equal(
        `fee.cc_standing_quote(domain=wildcard, target_router=${ROUTER_A_HEX})`,
      );
    });

    it('dedups default-route and default-standing pdas across routers in the same domain', async () => {
      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeSalt: DEFAULT_FEE_SALT,
        feeConfig: ccFeeConfig(),
        feeReadContext: feeContext({
          10: new Set([ROUTER_A_HEX, ROUTER_B_HEX]),
        }),
      });

      const ccRouteDefault = await deriveCrossCollateralRoutePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        DEFAULT_ROUTER,
      );
      const standingDefault = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        10,
        DEFAULT_ROUTER,
      );

      const addresses = addressesOf(result);
      // Default route + default standing show up exactly once even with
      // two enrolled target routers in the same domain.
      expect(
        addresses.filter((a) => a === ccRouteDefault.address),
      ).to.have.lengthOf(1);
      expect(
        addresses.filter((a) => a === standingDefault.address),
      ).to.have.lengthOf(1);
      // 2 cc routes + 2 specific standings + 2 wildcard standings
      // + 1 default route + 1 default standing + fee program + fee account = 10.
      expect(result).to.have.lengthOf(10);
    });
  });

  describe('canonicalization', () => {
    it('output is sorted ascending and deduped across variants', async () => {
      for (const feeConfig of [
        leafFeeConfig(),
        routingFeeConfig(),
        ccFeeConfig(),
      ]) {
        const result = await deriveFeeQuoteCascadeAltAddresses({
          feeProgram: FEE_PROGRAM,
          feeSalt: DEFAULT_FEE_SALT,
          feeConfig,
          feeReadContext: feeContext({
            10: new Set([ROUTER_A_HEX]),
            20: new Set([ROUTER_B_HEX]),
          }),
        });

        const addresses = addressesOf(result);
        expect(isSortedAscending([...addresses]), feeConfig.type).to.equal(
          true,
        );
        expect(new Set(addresses).size, feeConfig.type).to.equal(
          addresses.length,
        );
      }
    });
  });
});

const IGP_ACCOUNT: Address = address(
  '99gpAccountPda11111111111111111111111111111',
);
const NON_NATIVE_MINT: Address = address(
  'M1ntPda111111111111111111111111111111111111',
);
const SENDER_A: Address = address(
  'WarpProgramA1111111111111111111111111111111',
);
const SENDER_B: Address = address(
  'WarpProgramB1111111111111111111111111111111',
);

describe('deriveIgpQuoteCascadeAltAddresses', () => {
  it('returns just the per-sender wildcard + quote authority when no domains are enrolled and mint is native', async () => {
    const perSenderWildcard = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SYSTEM_PROGRAM_ADDRESS,
      WILDCARD_DOMAIN,
      SENDER_A,
    );
    const quoteAuthority = await deriveIgpQuoteAuthorityPda(SENDER_A);

    const result = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
      sender: SENDER_A,
      enrolledDomains: [],
    });

    expect(new Set(addressesOf(result))).to.deep.equal(
      new Set([perSenderWildcard.address, quoteAuthority.address]),
    );
    expect(result).to.have.lengthOf(2);

    const byAddress = new Map(result.map((e) => [e.address, e.description]));
    expect(byAddress.get(perSenderWildcard.address)).to.equal(
      'igp.standing_quote(mint=native, domain=wildcard, sender=self)',
    );
    expect(byAddress.get(quoteAuthority.address)).to.equal(
      'igp.quote_authority(sender=self)',
    );
  });

  it('native mint: emits one cascade (mint and native sentinel are the same — dedup)', async () => {
    const result = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
      sender: SENDER_A,
      enrolledDomains: [10, 20],
    });

    // (2 per-D × 2 domains) + 1 per-sender-wildcard + 1 quote-authority = 6
    expect(result).to.have.lengthOf(6);
  });

  it('non-native mint: emits cascades for BOTH the configured mint AND the native sentinel', async () => {
    const result = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: NON_NATIVE_MINT,
      sender: SENDER_A,
      enrolledDomains: [10, 20],
    });

    // 2 mints × ((2 per-D × 2 domains) + 1 per-sender-wildcard) + 1 quote-authority = 11
    expect(result).to.have.lengthOf(11);

    // Spot-check: a per-D pda exists under each mint.
    const perD10Native = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SYSTEM_PROGRAM_ADDRESS,
      10,
      SENDER_A,
    );
    const perD10Mint = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      NON_NATIVE_MINT,
      10,
      SENDER_A,
    );
    const perD10WildcardSenderNative = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SYSTEM_PROGRAM_ADDRESS,
      10,
      WILDCARD_SENDER,
    );
    const quoteAuthority = await deriveIgpQuoteAuthorityPda(SENDER_A);
    expect(addressesOf(result)).to.include.members([
      perD10Native.address,
      perD10Mint.address,
      perD10WildcardSenderNative.address,
      quoteAuthority.address,
    ]);

    const byAddress = new Map(result.map((e) => [e.address, e.description]));
    expect(byAddress.get(perD10Native.address)).to.equal(
      'igp.standing_quote(mint=native, domain=10, sender=self)',
    );
    expect(byAddress.get(perD10Mint.address)).to.equal(
      `igp.standing_quote(mint=${NON_NATIVE_MINT}, domain=10, sender=self)`,
    );
    expect(byAddress.get(perD10WildcardSenderNative.address)).to.equal(
      'igp.standing_quote(mint=native, domain=10, sender=wildcard)',
    );
    expect(byAddress.get(quoteAuthority.address)).to.equal(
      'igp.quote_authority(sender=self)',
    );
  });

  it('output is sorted ascending and deduped', async () => {
    const result = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: NON_NATIVE_MINT,
      sender: SENDER_A,
      enrolledDomains: [10, 20, 30],
    });

    const addresses = addressesOf(result);
    expect(isSortedAscending([...addresses])).to.equal(true);
    expect(new Set(addresses).size).to.equal(addresses.length);
  });

  it('different senders produce disjoint per-destination + per-sender-wildcard + quote-authority entries; wildcard-sender pdas stay stable', async () => {
    const aResult = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
      sender: SENDER_A,
      enrolledDomains: [10],
    });
    const bResult = await deriveIgpQuoteCascadeAltAddresses({
      igpProgram: IGP_PROGRAM,
      igpAccount: IGP_ACCOUNT,
      feeTokenMint: SYSTEM_PROGRAM_ADDRESS,
      sender: SENDER_B,
      enrolledDomains: [10],
    });

    const perD10WildcardSender = await deriveIgpStandingQuotePda(
      IGP_PROGRAM,
      IGP_ACCOUNT,
      SYSTEM_PROGRAM_ADDRESS,
      10,
      WILDCARD_SENDER,
    );

    const aAddresses = addressesOf(aResult);
    const bAddresses = addressesOf(bResult);
    expect(aAddresses).to.include(perD10WildcardSender.address);
    expect(bAddresses).to.include(perD10WildcardSender.address);

    const aOnly = aAddresses.filter((addr) => !bAddresses.includes(addr));
    const bOnly = bAddresses.filter((addr) => !aAddresses.includes(addr));

    // sender-A's per-D10-self + per-sender-wildcard + quote-authority differ from sender-B's
    expect(aOnly).to.have.lengthOf(3);
    expect(bOnly).to.have.lengthOf(3);
  });
});

describe('diffBucket', () => {
  const A: Address = address('Aaaa111111111111111111111111111111111111111');
  const B: Address = address('Bbbb111111111111111111111111111111111111111');
  const C: Address = address('Cccc111111111111111111111111111111111111111');
  const A_ANN: AnnotatedAltAddress = { address: A, description: 'a-desc' };
  const B_ANN: AnnotatedAltAddress = { address: B, description: 'b-desc' };

  it('returns empty diffs and no frozen mismatch when sets match and frozen', () => {
    const diff = diffBucket([A, B], [A_ANN, B_ANN], true);
    expect(diff.missingFromAlt).to.deep.equal([]);
    expect(diff.extraInAlt).to.deep.equal([]);
    expect(diff.unfrozen).to.equal(false);
  });

  it('flags missing addresses with their annotations', () => {
    const diff = diffBucket([A], [A_ANN, B_ANN], true);
    expect(diff.missingFromAlt).to.deep.equal([B_ANN]);
    expect(diff.extraInAlt).to.deep.equal([]);
  });

  it('flags extra addresses (raw, no annotation available)', () => {
    const diff = diffBucket([A, C], [A_ANN], true);
    expect(diff.missingFromAlt).to.deep.equal([]);
    expect(diff.extraInAlt).to.deep.equal([C]);
  });

  it('flags unfrozen when frozen=false', () => {
    const diff = diffBucket([A], [A_ANN], false);
    expect(diff.unfrozen).to.equal(true);
  });
});

// Generates `count` deterministic distinct base58 addresses by stuffing a
// little-endian counter into the first 4 bytes of an otherwise-zero pubkey.
// Any 32-byte buffer is a valid Solana address — we never sign with these.
function makeAddresses(count: number, offset = 0): AnnotatedAltAddress[] {
  const out: AnnotatedAltAddress[] = [];
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  for (let i = 1; i <= count; i += 1) {
    view.setUint32(0, i + offset, true);
    out.push({
      address: address(base58Encode(bytes)),
      description: `addr-${i + offset}`,
    });
  }
  return out;
}

function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let s = '';
  while (num > 0n) {
    s = ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

const CORE_ADDR: Address = address('11111111111111111111111111111112');
const NEW_CORE_ADDR: Address = address('11111111111111111111111111111113');
const NEW_WARP_ADDR_A: Address = address('11111111111111111111111111111114');
const NEW_WARP_ADDR_B: Address = address('11111111111111111111111111111115');

/** Returns a stub `altWriter.create` that yields the next address from
 * the queue on each call. Tests assert against call counts and the
 * payloads passed in. */
function stubAltWriter(yieldAddresses: Address[]) {
  const writer = sinon.createStubInstance(SvmAddressLookupTableWriter);
  let i = 0;
  writer.create.callsFake(async () => {
    const addr = yieldAddresses[i++];
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { frozen: true, addresses: [addr] as const },
        deployed: { address: addr, lastExtendedSlot: 0n, authority: null },
      },
      [],
    ];
  });
  return writer;
}

describe('createWarpAltsImpl — warpSpecific chunking', () => {
  it('emits one warp-specific ALT when entries fit in a single chunk', async () => {
    const writer = stubAltWriter([NEW_CORE_ADDR, NEW_WARP_ADDR_A]);
    const core = makeAddresses(5);
    const warpSpecific = makeAddresses(100, 1000);

    const result = await createWarpAltsImpl(
      writer,
      { core, warpSpecific },
      undefined,
    );

    expect(writer.create.callCount).to.equal(2);
    expect(result.core).to.equal(NEW_CORE_ADDR);
    expect(result.warpSpecific).to.deep.equal([NEW_WARP_ADDR_A]);
  });

  it('splits warpSpecific across multiple ALTs when over the 256 cap', async () => {
    const writer = stubAltWriter([
      NEW_CORE_ADDR,
      NEW_WARP_ADDR_A,
      NEW_WARP_ADDR_B,
    ]);
    const core = makeAddresses(5);
    const warpSpecific = makeAddresses(300, 1000);

    const result = await createWarpAltsImpl(
      writer,
      { core, warpSpecific },
      undefined,
    );

    // 1 core + ceil(300 / 256) = 2 warp-specific
    expect(writer.create.callCount).to.equal(3);
    expect(result.warpSpecific).to.deep.equal([
      NEW_WARP_ADDR_A,
      NEW_WARP_ADDR_B,
    ]);

    // First warp-specific batch is exactly 256; second is the remaining 44.
    const warpBatchSizes = writer.create
      .getCalls()
      .slice(1)
      .map((c) => c.args[0].config.addresses.length);
    expect(warpBatchSizes).to.deep.equal([256, 44]);
  });
});

describe('createWarpAltsImpl — existingCoreAlt reuse', () => {
  it('reuses existingCoreAlt and skips creating a new core ALT', async () => {
    const writer = stubAltWriter([NEW_WARP_ADDR_A]);
    const core = makeAddresses(5);
    const warpSpecific = makeAddresses(50, 1000);

    const result = await createWarpAltsImpl(
      writer,
      { core, warpSpecific },
      CORE_ADDR,
    );

    expect(writer.create.callCount).to.equal(1);
    expect(result.core).to.equal(CORE_ADDR);
    expect(result.warpSpecific).to.deep.equal([NEW_WARP_ADDR_A]);
  });

  it('creates a fresh core ALT when existingCoreAlt is undefined', async () => {
    const writer = stubAltWriter([NEW_CORE_ADDR, NEW_WARP_ADDR_A]);
    const core = makeAddresses(5);
    const warpSpecific = makeAddresses(50, 1000);

    const result = await createWarpAltsImpl(
      writer,
      { core, warpSpecific },
      undefined,
    );

    expect(writer.create.callCount).to.equal(2);
    expect(result.core).to.equal(NEW_CORE_ADDR);
  });
});
