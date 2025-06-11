import { inCIMode } from '@hyperlane-xyz/utils';

export const E2E_TEST_CONFIGS_PATH = './test-configs';
export const REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/hyp`;
export const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh

export const HYP_KEY =
  '33913dd43a5d5764f7a23da212a8664fc4f5eedc68db35f3eb4a5c4f046b5b51';

export const EXAMPLES_PATH = './examples/cosmosnative';

export const CHAIN_NAME_1 = 'hyp1';
export const CHAIN_NAME_2 = 'hyp2';
export const CHAIN_NAME_3 = 'hyp3';

export const CHAIN_1_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_1}/metadata.yaml`;
export const CHAIN_2_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`;
export const CHAIN_3_METADATA_PATH = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;

export const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;
export const CORE_READ_CONFIG_PATH_1 = `${TEMP_PATH}/${CHAIN_NAME_1}/core-config-read.yaml`;

export const DEFAULT_E2E_TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while

// Verifies if the IS_CI var is set and generates the correct prefix for running the command
// in the current env
export function localTestRunCmdPrefix() {
  return inCIMode() ? [] : ['yarn', 'workspace', '@hyperlane-xyz/cli', 'run'];
}
