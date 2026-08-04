import { expect } from 'chai';

import {
  ProposalResultStatus,
  computeExitCode,
  summarizeResults,
} from '../src/utils/warp-propose-result.js';

const { Proposed, DryRun, Skipped, Invalid, Unsupported, Failed } =
  ProposalResultStatus;

type Case = {
  name: string;
  statuses: ProposalResultStatus[];
  expectedExit: number;
};

const cases: Case[] = [
  {
    name: 'no files at all exits 0',
    statuses: [],
    expectedExit: 0,
  },
  {
    name: 'all proposed exits 0',
    statuses: [Proposed, Proposed],
    expectedExit: 0,
  },
  {
    name: 'proposed + skipped-by-filter exits 0',
    statuses: [Proposed, Skipped],
    expectedExit: 0,
  },
  {
    name: 'one failure + one skip exits 1 (partial success must not report ok)',
    statuses: [Failed, Skipped],
    expectedExit: 1,
  },
  {
    name: 'all skipped (e.g. filename mismatch) exits 1',
    statuses: [Skipped, Skipped],
    expectedExit: 1,
  },
  {
    name: 'dry-run over eligible files exits 0',
    statuses: [DryRun, DryRun],
    expectedExit: 0,
  },
  {
    name: 'dry-run but every file unparseable exits 1',
    statuses: [Skipped],
    expectedExit: 1,
  },
  {
    name: 'mixed proposed + failed exits 1',
    statuses: [Proposed, Failed],
    expectedExit: 1,
  },
  {
    name: 'proposed + unsupported-governance exits 1 (undone work must not report ok)',
    statuses: [Proposed, Unsupported],
    expectedExit: 1,
  },
  {
    name: 'unsupported + out-of-scope skip exits 1',
    statuses: [Unsupported, Skipped],
    expectedExit: 1,
  },
  {
    name: 'proposed + invalid exits 1 (intended-but-malformed receipt must not report ok)',
    statuses: [Proposed, Invalid],
    expectedExit: 1,
  },
  {
    name: 'invalid + out-of-scope skip exits 1',
    statuses: [Invalid, Skipped],
    expectedExit: 1,
  },
];

describe('warp-propose-result', () => {
  describe('summarizeResults', () => {
    it('classifies proposed/dry-run/failed/unsupported as eligible and skipped/invalid as not', () => {
      const counts = summarizeResults([
        Proposed,
        DryRun,
        Failed,
        Invalid,
        Unsupported,
        Skipped,
        Skipped,
      ]);
      expect(counts).to.deep.equal({
        candidate: 7,
        eligible: 4,
        proposed: 1,
        dryRun: 1,
        failed: 1,
        invalid: 1,
        unsupported: 1,
        skipped: 2,
      });
    });
  });

  describe('computeExitCode', () => {
    for (const c of cases) {
      it(c.name, () => {
        const counts = summarizeResults(c.statuses);
        expect(computeExitCode(counts)).to.equal(c.expectedExit);
      });
    }
  });
});
