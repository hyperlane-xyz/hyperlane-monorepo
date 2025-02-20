import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../commands/helpers.js';

import {
  TOTAL_PARTS,
  WarpBridgeTestConfig,
  runWarpBridgeTests,
  setupChains,
} from './warp-bridge-utils.js';

chai.use(chaiAsPromised);
chai.should();

const INDEX = 0;

describe('hyperlane warp deploy and bridge e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let config: WarpBridgeTestConfig;

  before(async function () {
    config = await setupChains();
  });

  it(`Should deploy and bridge different types of warp routes - Part ${
    INDEX + 1
  } of ${TOTAL_PARTS}`, async function () {
    await runWarpBridgeTests(config, TOTAL_PARTS, INDEX);
  });
});
