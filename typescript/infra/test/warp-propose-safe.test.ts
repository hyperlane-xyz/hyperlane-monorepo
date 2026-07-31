import { expect } from 'chai';

import { GovernanceType } from '../src/governanceTypes.js';
import {
  GovernanceSafeEntry,
  NonceService,
  checkSignerOwnsSafe,
  createNonceAllocator,
  parseFilename,
  resolveGovernanceSafe,
  toMetaTransactionData,
} from '../src/utils/warp-propose-safe.js';

const SAFE_A = '0x3965ac0F1c777Cd3aA0F9c07D07Ce367Fd8f4c6f';
const SAFE_B = '0x3965ac9999999999999999999999999999999999';
const SAFE_C = '0xABCDEF0123456789012345678901234567890123';
const SIGNER = '0xa7EC0000000000000000000000000000000000d9';

// Reproduce the producer's filename construction so the test breaks if the
// consumer regex and `writeCombinedBundles` (warp.ts) ever drift apart.
function producerFilename(chainId: string, safeAddress: string): string {
  const safeSegment = safeAddress ? `-safe${safeAddress.slice(0, 8)}` : '';
  return `combined-chainId${chainId}${safeSegment}-1700000000000-receipts.json`;
}

describe('warp-propose-safe', () => {
  describe('parseFilename', () => {
    it('parses the exact form `writeCombinedBundles` emits (0x + 6 hex)', () => {
      const filename = producerFilename('1', SAFE_A);
      const parsed = parseFilename(filename);
      expect('error' in parsed).to.be.false;
      if ('error' in parsed) {
        return;
      }
      expect(parsed.chainIdStr).to.equal('1');
      expect(parsed.safePrefix).to.equal(SAFE_A.slice(0, 8));
    });

    it('rejects the legacy 8-bare-hex form (no 0x)', () => {
      const filename =
        'combined-chainId1-safe3965ac0F-1700000000000-receipts.json';
      const parsed = parseFilename(filename);
      expect('error' in parsed).to.be.true;
    });

    it('rejects a filename with no safe segment', () => {
      const filename = 'combined-chainId1-1700000000000-receipts.json';
      const parsed = parseFilename(filename);
      expect('error' in parsed).to.be.true;
    });
  });

  describe('resolveGovernanceSafe', () => {
    const prefix = SAFE_A.slice(0, 8);

    it('resolves a unique prefix match', () => {
      const entries: GovernanceSafeEntry[] = [
        { governanceType: GovernanceType.Regular, safe: SAFE_A },
        { governanceType: GovernanceType.OUSDT, safe: SAFE_C },
      ];
      const result = resolveGovernanceSafe(prefix, entries);
      expect('error' in result).to.be.false;
      if ('error' in result) {
        return;
      }
      expect(result.safe).to.equal(SAFE_A);
      expect(result.governanceType).to.equal(GovernanceType.Regular);
    });

    it('fails closed when no governance safe matches', () => {
      const entries: GovernanceSafeEntry[] = [
        { governanceType: GovernanceType.Regular, safe: SAFE_C },
      ];
      const result = resolveGovernanceSafe(prefix, entries);
      expect('error' in result).to.be.true;
    });

    it('fails closed when the prefix is ambiguous across governance types', () => {
      const entries: GovernanceSafeEntry[] = [
        { governanceType: GovernanceType.Regular, safe: SAFE_A },
        { governanceType: GovernanceType.AbacusWorks, safe: SAFE_B },
      ];
      const result = resolveGovernanceSafe(prefix, entries);
      expect('error' in result).to.be.true;
    });
  });

  describe('checkSignerOwnsSafe', () => {
    it('accepts a signer present in the owner set (case-insensitive)', () => {
      const result = checkSignerOwnsSafe(
        [SAFE_C, SIGNER.toLowerCase()],
        SIGNER,
        GovernanceType.Regular,
      );
      expect(result.owned).to.be.true;
    });

    it('skips with a reason when the signer is not an owner', () => {
      const result = checkSignerOwnsSafe(
        [SAFE_C],
        SIGNER,
        GovernanceType.Irregular,
      );
      expect(result.owned).to.be.false;
      if (result.owned) {
        return;
      }
      expect(result.reason).to.contain(GovernanceType.Irregular);
    });
  });

  describe('createNonceAllocator', () => {
    function stubService(nextNonce: string): NonceService & { calls: number } {
      return {
        calls: 0,
        async getNextNonce() {
          this.calls += 1;
          return nextNonce;
        },
      };
    }

    it('bases on getNextNonce once per safe and increments per call', async () => {
      const allocate = createNonceAllocator();
      const service = stubService('5');

      expect(await allocate(SAFE_A, service)).to.equal(5);
      expect(await allocate(SAFE_A, service)).to.equal(6);
      expect(await allocate(SAFE_A, service)).to.equal(7);
      // Base nonce fetched exactly once; later nonces come from the local offset.
      expect(service.calls).to.equal(1);
    });

    it('tracks a separate base + offset sequence per safe', async () => {
      const allocate = createNonceAllocator();
      const serviceA = stubService('10');
      const serviceB = stubService('20');

      expect(await allocate(SAFE_A, serviceA)).to.equal(10);
      expect(await allocate(SAFE_B, serviceB)).to.equal(20);
      expect(await allocate(SAFE_A, serviceA)).to.equal(11);
      expect(await allocate(SAFE_B, serviceB)).to.equal(21);
      expect(serviceA.calls).to.equal(1);
      expect(serviceB.calls).to.equal(1);
    });
  });

  describe('toMetaTransactionData', () => {
    it('defaults value and data and preserves operation when present', () => {
      const meta = toMetaTransactionData({
        to: SAFE_C,
        operation: 1,
      });
      expect(meta.to).to.equal(SAFE_C);
      expect(meta.value).to.equal('0');
      expect(meta.data).to.equal('0x');
      expect(meta.operation).to.equal(1);
    });

    it('stringifies a numeric value and omits operation when absent', () => {
      const meta = toMetaTransactionData({
        to: SAFE_C,
        value: 42,
        data: '0xabcd',
      });
      expect(meta.value).to.equal('42');
      expect(meta.data).to.equal('0xabcd');
      expect(meta.operation).to.equal(undefined);
    });
  });
});
