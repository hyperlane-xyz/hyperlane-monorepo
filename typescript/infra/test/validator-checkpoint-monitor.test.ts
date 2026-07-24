import { expect } from 'chai';

import { addressToBytes32 } from '@hyperlane-xyz/utils';
import type { Checkpoint } from '@hyperlane-xyz/utils';

import { ValidatorSetName } from '../src/validators/monitorConfig.js';
import {
  type ValidatorRow,
  assertFullSnapshotPush,
  buildValidatorMetricsRegistry,
  checkpointMatchesExpected,
} from '../scripts/validators/monitor-checkpoints.js';

const VALIDATOR = '0x1111111111111111111111111111111111111111';
const OTHER_VALIDATOR = '0x2222222222222222222222222222222222222222';
const MERKLE_TREE_HOOK = '0x3333333333333333333333333333333333333333';
const OTHER_MERKLE_TREE_HOOK = '0x4444444444444444444444444444444444444444';
const DOMAIN = 1234;
const INDEX = 42;

const CHECKPOINT: Checkpoint = {
  root: `0x${'ab'.repeat(32)}`,
  index: INDEX,
  mailbox_domain: DOMAIN,
  merkle_tree_hook_address: addressToBytes32(MERKLE_TREE_HOOK),
};

describe('validator checkpoint monitor', () => {
  describe('assertFullSnapshotPush', () => {
    it('allows unfiltered pushes and filtered local reads', () => {
      expect(() => assertFullSnapshotPush(true)).not.to.throw();
      expect(() =>
        assertFullSnapshotPush(false, ValidatorSetName.Renzo, ['ethereum']),
      ).not.to.throw();
    });

    it('rejects filtered pushes that would overwrite the full snapshot', () => {
      expect(() =>
        assertFullSnapshotPush(true, ValidatorSetName.Renzo),
      ).to.throw('--pushMetrics cannot be combined with --set or --chains');
      expect(() =>
        assertFullSnapshotPush(true, undefined, ['ethereum']),
      ).to.throw('--pushMetrics cannot be combined with --set or --chains');
    });
  });

  describe('checkpointMatchesExpected', () => {
    it('accepts a valid signed checkpoint without consulting a stale on-chain snapshot', () => {
      expect(
        checkpointMatchesExpected(
          CHECKPOINT,
          VALIDATOR,
          VALIDATOR,
          DOMAIN,
          MERKLE_TREE_HOOK,
          INDEX,
        ),
      ).to.be.true;
    });

    it('rejects a wrong signer', () => {
      expect(
        checkpointMatchesExpected(
          CHECKPOINT,
          OTHER_VALIDATOR,
          VALIDATOR,
          DOMAIN,
          MERKLE_TREE_HOOK,
          INDEX,
        ),
      ).to.be.false;
    });

    it('rejects a wrong domain', () => {
      expect(
        checkpointMatchesExpected(
          CHECKPOINT,
          VALIDATOR,
          VALIDATOR,
          DOMAIN + 1,
          MERKLE_TREE_HOOK,
          INDEX,
        ),
      ).to.be.false;
    });

    it('rejects a wrong merkle tree hook', () => {
      expect(
        checkpointMatchesExpected(
          CHECKPOINT,
          VALIDATOR,
          VALIDATOR,
          DOMAIN,
          OTHER_MERKLE_TREE_HOOK,
          INDEX,
        ),
      ).to.be.false;
    });

    it('rejects a checkpoint whose signed index differs from latest', () => {
      expect(
        checkpointMatchesExpected(
          CHECKPOINT,
          VALIDATOR,
          VALIDATOR,
          DOMAIN,
          MERKLE_TREE_HOOK,
          INDEX + 1,
        ),
      ).to.be.false;
    });
  });

  it('publishes reachable=0 when no checkpoint exists', async () => {
    const row: ValidatorRow = {
      set: ValidatorSetName.Renzo,
      chain: 'ethereum',
      address: VALIDATOR,
      alias: 'test-validator',
      status: 'none',
      index: -1,
      onchainCount: 100,
      lagOnchain: undefined,
      lagPeer: undefined,
    };

    const metrics = await buildValidatorMetricsRegistry([row], {
      ethereum: 100,
    }).metrics();

    expect(metrics).to.include(
      `hyperlane_validator_reachable{chain="ethereum",validator="${VALIDATOR}",alias="test-validator",validator_set="renzo"} 0`,
    );
    expect(metrics).not.to.include(
      'hyperlane_validator_checkpoint_index{chain="ethereum"',
    );
  });
});
