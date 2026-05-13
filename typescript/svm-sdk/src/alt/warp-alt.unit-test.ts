import { type Address, address } from '@solana/kit';
import { expect } from 'chai';

import {
  type FeeArtifactConfig,
  type FeeReadContext,
  FeeParamsType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';

import { DEFAULT_ROUTER } from '../codecs/fee.js';
import { WILDCARD_DOMAIN } from '../codecs/igp.js';
import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { DEFAULT_IGP_SALT, deriveIgpSalt } from '../hook/igp-hook.js';
import { H256_ZERO } from '../instructions/fee.js';
import {
  deriveCrossCollateralRoutePda,
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';

import {
  deriveCoreDeploymentAltAddresses,
  deriveFeeQuoteCascadeAltAddresses,
} from './warp-alt.js';

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
    expect(new Set(result)).to.deep.equal(
      new Set([
        SYSTEM_PROGRAM_ADDRESS,
        SPL_NOOP_PROGRAM_ADDRESS,
        SPL_TOKEN_PROGRAM_ADDRESS,
        MAILBOX,
        outbox,
      ]),
    );
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
    expect(result).to.include.members([IGP_PROGRAM, programData, igpAccount]);
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
    expect(result).to.include(overhead);
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
      includeOverheadIgp: true,
    });

    expect(isSortedAscending([...result])).to.equal(
      true,
      `expected ascending order, got: ${result.join(', ')}`,
    );
    expect(new Set(result).size).to.equal(result.length);
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

    const aSet = new Set(a);
    const bSet = new Set(b);
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
const FEE_ACCOUNT: Address = address(
  'F1ee1AccountPda1111111111111111111111111111',
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
  describe('Leaf variants (linear / regressive / progressive / offchainQuoted)', () => {
    it('returns just the wildcard standing pda when no domains are enrolled', async () => {
      const wildcard = await deriveStandingQuotePda(
        FEE_PROGRAM,
        FEE_ACCOUNT,
        WILDCARD_DOMAIN,
        H256_ZERO,
      );

      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeAccount: FEE_ACCOUNT,
        feeConfig: leafFeeConfig(),
        feeReadContext: feeContext({}),
      });

      expect(result).to.deep.equal([wildcard.address].sort());
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
        feeAccount: FEE_ACCOUNT,
        feeConfig: leafFeeConfig(),
        feeReadContext: feeContext({
          10: new Set([ROUTER_A_HEX]),
          20: new Set([ROUTER_B_HEX]),
        }),
      });

      expect(new Set(result)).to.deep.equal(
        new Set([standingA.address, standingB.address, wildcard.address]),
      );
      expect(result).to.have.lengthOf(3);
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
        feeAccount: FEE_ACCOUNT,
        feeConfig: routingFeeConfig(),
        feeReadContext: feeContext({ 10: new Set([ROUTER_A_HEX]) }),
      });

      expect(new Set(result)).to.deep.equal(
        new Set([standing.address, wildcard.address, route.address]),
      );
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
        feeAccount: FEE_ACCOUNT,
        feeConfig: ccFeeConfig(),
        feeReadContext: feeContext({ 10: new Set([ROUTER_A_HEX]) }),
      });

      expect(new Set(result)).to.deep.equal(
        new Set([
          ccRouteA.address,
          ccRouteDefault.address,
          standingA.address,
          standingDefault.address,
          wildcardA.address,
        ]),
      );
    });

    it('dedups default-route and default-standing pdas across routers in the same domain', async () => {
      const result = await deriveFeeQuoteCascadeAltAddresses({
        feeProgram: FEE_PROGRAM,
        feeAccount: FEE_ACCOUNT,
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

      // Default route + default standing show up exactly once even with
      // two enrolled target routers in the same domain.
      expect(
        result.filter((a) => a === ccRouteDefault.address),
      ).to.have.lengthOf(1);
      expect(
        result.filter((a) => a === standingDefault.address),
      ).to.have.lengthOf(1);
      // 2 cc routes + 2 specific standings + 2 wildcard standings
      // + 1 default route + 1 default standing = 8.
      expect(result).to.have.lengthOf(8);
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
          feeAccount: FEE_ACCOUNT,
          feeConfig,
          feeReadContext: feeContext({
            10: new Set([ROUTER_A_HEX]),
            20: new Set([ROUTER_B_HEX]),
          }),
        });

        expect(isSortedAscending([...result]), feeConfig.type).to.equal(true);
        expect(new Set(result).size, feeConfig.type).to.equal(result.length);
      }
    });
  });
});
