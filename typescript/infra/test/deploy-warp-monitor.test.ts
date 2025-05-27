import { expect } from 'chai';
import * as child_process from 'child_process';
import sinon from 'sinon';

import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import * as utils from '@hyperlane-xyz/utils';

import * as registryModule from '../config/registry.js';
import { validateRegistryCommit } from '../scripts/warp-routes/deploy-warp-monitor.js';

describe('validateRegistryCommit', () => {
  let execSyncStub: sinon.SinonStub;
  let getRegistryStub: sinon.SinonStub;
  let rootLoggerInfoStub: sinon.SinonStub;
  let rootLoggerWarnStub: sinon.SinonStub;
  let rootLoggerErrorStub: sinon.SinonStub;
  let processExitStub: sinon.SinonStub;
  let fakeRegistry: FileSystemRegistry;

  beforeEach(() => {
    execSyncStub = sinon.stub(child_process, 'execSync');
    fakeRegistry = {
      getUri: sinon.stub().returns('/fake/uri'),
    } as unknown as FileSystemRegistry;
    getRegistryStub = sinon
      .stub(registryModule, 'getRegistry')
      .returns(fakeRegistry);
    rootLoggerInfoStub = sinon.stub(utils.rootLogger, 'info');
    rootLoggerWarnStub = sinon.stub(utils.rootLogger, 'warn');
    rootLoggerErrorStub = sinon.stub(utils.rootLogger, 'error');
    processExitStub = sinon.stub(process, 'exit');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns the commit if fetch succeeds', async () => {
    execSyncStub.returns(undefined);
    const result = await validateRegistryCommit('abc123');
    expect(result).to.equal('abc123');
    expect(execSyncStub.calledWith('cd /fake/uri && git fetch origin abc123'))
      .to.be.true;
    expect(processExitStub.notCalled).to.be.true;
  });

  it('returns main if fetch fails but fallback succeeds', async () => {
    execSyncStub
      .onFirstCall()
      .throws(new Error('fail'))
      .onSecondCall()
      .returns(undefined);
    const result = await validateRegistryCommit('abc123');
    expect(result).to.equal('main');
    expect(execSyncStub.firstCall.args[0]).to.include(
      'git fetch origin abc123',
    );
    expect(execSyncStub.secondCall.args[0]).to.include('git fetch origin main');
    expect(processExitStub.notCalled).to.be.true;
  });

  it('calls process.exit(1) if both fetches fail', async () => {
    execSyncStub
      .onFirstCall()
      .throws(new Error('fail'))
      .onSecondCall()
      .throws(new Error('fail again'));
    await validateRegistryCommit('abc123');
    expect(processExitStub.calledOnceWith(1)).to.be.true;
  });
});
