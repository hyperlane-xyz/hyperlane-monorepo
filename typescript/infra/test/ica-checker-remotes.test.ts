import { expect } from 'chai';
import sinon from 'sinon';

import {
  HyperlaneRouterChecker,
  InterchainAccount,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { HyperlaneICAChecker } from '../src/govern/HyperlaneICAChecker.js';

describe('ICA checker selected-generation remotes', () => {
  afterEach(() => sinon.restore());

  it('checks only deployed remotes for the selected generation', async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const app = new InterchainAccount({}, mp);
    sinon.stub(app, 'chains').returns(['test1', 'elysium']);
    const check = sinon
      .stub(HyperlaneRouterChecker.prototype, 'checkEnrolledRouters')
      .resolves();
    const checker = new HyperlaneICAChecker(mp, app, {});
    await checker.checkIcaRouterEnrollment('test1');
    expect(check.calledOnceWithExactly('test1', ['elysium'])).to.equal(true);
  });

  it('preserves the Eden exclusion on fully connected chains', async () => {
    const mp = MultiProvider.createTestMultiProvider();
    const app = new InterchainAccount({}, mp);
    sinon.stub(app, 'remoteChains').resolves(['test1', 'eden']);
    const check = sinon
      .stub(HyperlaneRouterChecker.prototype, 'checkEnrolledRouters')
      .resolves();
    const checker = new HyperlaneICAChecker(mp, app, {});
    await checker.checkIcaRouterEnrollment('elysium');
    expect(check.calledOnceWithExactly('elysium', ['test1'])).to.equal(true);
  });
});
