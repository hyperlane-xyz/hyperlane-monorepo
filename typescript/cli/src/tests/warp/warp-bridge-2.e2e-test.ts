import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../commands/helpers.js';

import {
  TOTAL_PARTS,
  WarpBridgeTestConfig,
  generateTestCases,
  runWarpBridgeTests,
  setupChains,
} from './warp-bridge-utils.js';

chai.use(chaiAsPromised);
chai.should();

const INDEX = 1;

describe('hyperlane warp deploy and bridge e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let config: WarpBridgeTestConfig;
  let warpConfigTestCases: ReadonlyArray<WarpRouteDeployConfig>;

  before(async function () {
    config = await setupChains();
    warpConfigTestCases = generateTestCases(config, TOTAL_PARTS, INDEX);
  });

  it(`Should deploy and bridge different types of warp routes - Part ${
    INDEX + 1
  } of ${TOTAL_PARTS}`, async function () {
    this.timeout(warpConfigTestCases.length * DEFAULT_E2E_TEST_TIMEOUT);
    await runWarpBridgeTests(config, warpConfigTestCases);
  });
});
