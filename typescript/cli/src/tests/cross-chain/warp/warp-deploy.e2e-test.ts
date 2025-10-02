import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { DEFAULT_E2E_TEST_TIMEOUT } from '../../ethereum/consts.js';
import { runCosmosNode } from '../../nodes.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  before(async function () {
    await runCosmosNode();
  });

  it('should do something', () => {
    expect(0).to.eql(0);
  });
});
