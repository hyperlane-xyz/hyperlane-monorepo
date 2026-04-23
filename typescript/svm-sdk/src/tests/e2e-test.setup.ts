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

const TESTS_WITHOUT_VALIDATOR = new Set(['read-token']);

const ALL_PRELOADED_PROGRAMS: Array<PreloadableProgram> = [
  'mailbox',
  'igp',
  'testIsm',
  'multisigIsm',
  'validatorAnnounce',
];

export default async function () {
  const skipValidator = TESTS_WITHOUT_VALIDATOR.has(
    process.env.SVM_SDK_E2E_TEST ?? '',
  );
  if (skipValidator) {
    return async () => {};
  }

  rootLogger.info('Preparing SVM programs...');
  const { programs, cleanup } = getPreloadedPrograms(ALL_PRELOADED_PROGRAMS);

  let validator: SolanaTestValidator | undefined;
  try {
    rootLogger.info('Starting Solana test validator...');
    validator = await runSolanaNode(TEST_SVM_CHAIN_METADATA, programs);
    rootLogger.info(`Solana test validator started at ${validator.rpcUrl}`);
  } catch (error: unknown) {
    cleanup();
    throw error;
  }

  return async () => {
    if (validator) {
      rootLogger.info('Stopping Solana test validator...');
      await validator.stop();
      rootLogger.info('Solana test validator stopped');
    }
    cleanup();
  };
}
