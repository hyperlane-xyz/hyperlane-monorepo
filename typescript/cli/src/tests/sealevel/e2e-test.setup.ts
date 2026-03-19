import fs from 'fs';

import {
  type SolanaTestValidator,
  airdropSol,
  getPreloadedPrograms,
  runSolanaNode,
} from '@hyperlane-xyz/sealevel-sdk/testing';
import { createRpc } from '@hyperlane-xyz/sealevel-sdk';

import {
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../constants.js';

// Longer timeout for setup: validator startup + airdrop
const SETUP_TIMEOUT_MS = 180_000;

let validator: SolanaTestValidator | undefined;
let programCleanup: (() => void) | undefined;

before(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  // Clean up existing chain addresses
  Object.entries(TEST_CHAIN_NAMES_BY_PROTOCOL).forEach(
    ([_protocol, chainNames]) => {
      Object.entries(chainNames).map(([_key, name]) => {
        const path = `${REGISTRY_PATH}/chains/${name}/addresses.yaml`;

        if (fs.existsSync(path)) {
          fs.rmSync(path, { recursive: true, force: true });
        }
      });
    },
  );

  // Write the Token-2022 override programs to temp files and start the validator.
  // Core programs (mailbox, ISM, hooks, VA) are deployed from embedded bytes
  // by the writers during `hyperlane core deploy`.
  const { programs, cleanup } = getPreloadedPrograms([]);
  programCleanup = cleanup;

  try {
    validator = await runSolanaNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      programs,
    );

    // Fund the deployer
    const rpc = createRpc(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl,
    );
    await airdropSol(
      rpc,
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel as any,
      50_000_000_000n,
    );
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
});

// Reset the test registry for each test invocation
beforeEach(() => {
  const deploymentPaths = `${REGISTRY_PATH}/deployments/warp_routes`;

  if (fs.existsSync(deploymentPaths)) {
    fs.rmSync(deploymentPaths, { recursive: true, force: true });
  }
});

after(async function () {
  this.timeout(SETUP_TIMEOUT_MS);

  await validator?.stop();
  programCleanup?.();
});
