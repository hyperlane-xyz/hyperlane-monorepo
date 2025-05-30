import { expect } from 'chai';
import sinon from 'sinon';

import { validateRegistryCommit } from '../scripts/warp-routes/deploy-warp-monitor.js';

describe('validateRegistryCommit', () => {
  let mockExecSync: sinon.SinonStub;
  let processExitStub: sinon.SinonStub;
  let mockLogger: any;

  const fakeRegistryUri = '/fake/registry/uri';

  beforeEach(() => {
    mockExecSync = sinon.stub();
    processExitStub = sinon.stub(process, 'exit').callsFake(() => {
      throw new Error('process.exit called');
    });
    mockLogger = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns the commit if fetch succeeds', async () => {
    mockExecSync.returns(undefined);
    const result = await validateRegistryCommit(
      'abc123',
      fakeRegistryUri,
      mockLogger,
      mockExecSync,
    );
    expect(result).to.equal('abc123');
    expect(
      mockExecSync.calledWith(
        `cd ${fakeRegistryUri} && git fetch origin abc123`,
      ),
    ).to.be.true;
    expect(mockLogger.info.calledTwice).to.be.true;
    expect(processExitStub.notCalled).to.be.true;
  });

  it('returns main if fetch fails but fallback succeeds', async () => {
    mockExecSync
      .onFirstCall()
      .throws(new Error('fail'))
      .onSecondCall()
      .returns(undefined);
    const result = await validateRegistryCommit(
      'abc123',
      fakeRegistryUri,
      mockLogger,
      mockExecSync,
    );
    expect(result).to.equal('main');
    expect(mockExecSync.firstCall.args[0]).to.include(
      'git fetch origin abc123',
    );
    expect(mockExecSync.secondCall.args[0]).to.include('git fetch origin main');
    expect(mockLogger.warn.calledOnce).to.be.true;
    expect(mockLogger.info.calledTwice).to.be.true;
    expect(processExitStub.notCalled).to.be.true;
  });

  it('calls process.exit(1) if both fetches fail', async () => {
    mockExecSync
      .onFirstCall()
      .throws(new Error('fail'))
      .onSecondCall()
      .throws(new Error('fail again'));

    try {
      await validateRegistryCommit(
        'abc123',
        fakeRegistryUri,
        mockLogger,
        mockExecSync,
      );
      expect.fail('Expected function to call process.exit');
    } catch (error: any) {
      expect(error.message).to.equal('process.exit called');
    }

    expect(mockLogger.warn.calledOnce).to.be.true;
    expect(mockLogger.error.calledOnce).to.be.true;
  });

  it('uses the provided registry URI in git commands', async () => {
    const customUri = '/custom/registry/path';
    mockExecSync.returns(undefined);
    await validateRegistryCommit(
      'test-commit',
      customUri,
      mockLogger,
      mockExecSync,
    );
    expect(
      mockExecSync.calledWith(
        `cd ${customUri} && git fetch origin test-commit`,
      ),
    ).to.be.true;
    expect(mockLogger.info.calledTwice).to.be.true;
  });

  it('logs appropriate messages during execution', async () => {
    mockExecSync.returns(undefined);
    await validateRegistryCommit(
      'abc123',
      fakeRegistryUri,
      mockLogger,
      mockExecSync,
    );

    expect(mockLogger.info.firstCall.args[0]).to.include(
      'Attempting to fetch registry commit abc123',
    );
    expect(mockLogger.info.secondCall.args[0]).to.include(
      'Fetch completed successfully',
    );
  });
});
