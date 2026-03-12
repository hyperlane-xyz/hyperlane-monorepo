import { rootLogger } from '@hyperlane-xyz/utils';

import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import {
  type PreloadableProgram,
  getPreloadedPrograms,
} from '../testing/setup.js';
import {
  type SolanaTestValidator,
  runSolanaNode,
} from '../testing/solana-container.js';

const SETUP_TIMEOUT_MS = 150_000;
const TESTS_WITHOUT_VALIDATOR = new Set(['read-token']);
const SKIP_VALIDATOR = TESTS_WITHOUT_VALIDATOR.has(
  process.env.SVM_SDK_E2E_TEST ?? '',
);

const ALL_PRELOADED_PROGRAMS: Array<PreloadableProgram> = [
  'mailbox',
  'igp',
  'testIsm',
  'multisigIsm',
];

let validator: SolanaTestValidator | undefined;
let programCleanup: (() => void) | undefined;

before(async function () {
  if (SKIP_VALIDATOR) return;
  this.timeout(SETUP_TIMEOUT_MS);

  rootLogger.info('Preparing SVM programs...');
  const { programs, cleanup } = getPreloadedPrograms(ALL_PRELOADED_PROGRAMS);
  programCleanup = cleanup;

  rootLogger.info('Starting Solana test validator...');
  validator = await runSolanaNode(TEST_SVM_CHAIN_METADATA, programs);
  rootLogger.info(
    `Solana test validator started at ${TEST_SVM_CHAIN_METADATA.rpcUrl}`,
  );
});

after(async function () {
  if (SKIP_VALIDATOR) return;
  this.timeout(SETUP_TIMEOUT_MS);

  if (validator) {
    rootLogger.info('Stopping Solana test validator...');
    await validator.stop();
    rootLogger.info('Solana test validator stopped');
  }

  programCleanup?.();
});
