import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sinon from 'sinon';

import { FileSystemRegistry } from '@hyperlane-xyz/registry/fs';
import {
  ChainMap,
  ChainName,
  HyperlaneDeployer,
  MultiProvider,
} from '@hyperlane-xyz/sdk';

import { getRegistry, setRegistry } from '../config/registry.js';
import { Modules } from '../scripts/agent-utils.js';
import {
  DeployCache,
  DeploymentRun,
  DeployStatus,
  baseDeploy,
  deployWithArtifacts,
} from '../src/deployment/deploy.js';

class TestDeployer extends HyperlaneDeployer<object, {}> {
  async deployContracts(_chain: ChainName, _config: object) {
    return {};
  }
}

class ProcessExit extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super('process exited');
  }
}

describe('deployment lifecycle', () => {
  const sandbox = sinon.createSandbox();
  let directory: string;
  let multiProvider: MultiProvider;
  let deployer: TestDeployer;
  let cache: DeployCache;
  let previousRegistry: FileSystemRegistry;
  let registry: FileSystemRegistry;
  let failingSigners: Set<string>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'deployment-lifecycle-'));
    previousRegistry = getRegistry();
    registry = new FileSystemRegistry({ uri: directory });
    setRegistry(registry);
    multiProvider = MultiProvider.createTestMultiProvider();
    failingSigners = new Set();
    sandbox.stub(multiProvider, 'getSignerAddress').callsFake(async (chain) => {
      if (failingSigners.has(String(chain)))
        throw new Error('signer unavailable');
      return 'deployer';
    });
    deployer = new TestDeployer(multiProvider, {});
    cache = {
      read: false,
      write: false,
      environment: 'mainnet3',
      module: Modules.CORE,
      verification: join(directory, 'verification.json'),
    };
    sandbox.stub(console, 'info');
    sandbox.stub(console, 'warn');
    sandbox.stub(console, 'error');
    sandbox.stub(console, 'table');
    sandbox.stub(process, 'exit').callsFake((code) => {
      throw new ProcessExit(code);
    });
  });

  afterEach(() => {
    sandbox.restore();
    setRegistry(previousRegistry);
    rmSync(directory, { recursive: true, force: true });
  });

  async function exitCode(
    configMap: ChainMap<object> = { test1: {}, test2: {} },
    concurrentDeploy = false,
  ) {
    try {
      await deployWithArtifacts({
        configMap,
        deployer,
        cache,
        targetNetworks: [],
        module: Modules.CORE,
        multiProvider,
        concurrentDeploy,
      });
    } catch (error: unknown) {
      if (error instanceof ProcessExit) return error.code;
      throw error;
    }
    throw new Error('Expected process exit');
  }

  for (const concurrent of [false, true]) {
    it(`accounts for signer failure, settles siblings and exits nonzero (concurrent=${concurrent})`, async () => {
      failingSigners.add('test1');
      const deploy = sandbox.spy(deployer, 'deployContracts');
      expect(await exitCode(undefined, concurrent)).to.equal(1);
      expect(deploy.calledOnce).to.equal(true);
      expect(deploy.firstCall.args[0]).to.equal('test2');
    });
  }

  it('keeps outcomes local to each invocation', async () => {
    const deploy = sandbox.stub(deployer, 'deployContracts');
    deploy.onFirstCall().rejects(new Error('failed'));
    deploy.resolves({});
    expect(await exitCode({ test1: {}, test2: {} })).to.equal(1);
    expect(await exitCode({ test1: {}, test2: {} })).to.equal(0);
  });

  it('awaits artifact writes and exits nonzero on failed verification persistence', async () => {
    cache.write = true;
    // A directory cannot be overwritten as a file, regardless of mkdir behavior.
    cache.verification = directory;
    expect(await exitCode({})).to.equal(1);
  });

  it('does not replace malformed existing verification evidence', async () => {
    cache.write = true;
    writeFileSync(cache.verification, '{malformed');
    expect(await exitCode({})).to.equal(1);
    expect(readFileSync(cache.verification, 'utf8')).to.equal('{malformed');
  });

  it('still saves verification evidence when an address write fails', async () => {
    cache.write = true;
    deployer.cachedAddresses = { test1: { mailbox: 'mailbox' } };
    deployer.verificationInputs = {
      test1: [{ name: 'Mailbox', address: 'mailbox' }],
    };
    sandbox
      .stub(registry, 'updateChain')
      .throws(new Error('address write failed'));
    expect(await exitCode({})).to.equal(1);
    expect(JSON.parse(readFileSync(cache.verification, 'utf8'))).to.deep.equal(
      deployer.verificationInputs,
    );
  });

  it('interrupts admission, drains the active chain, flushes once and exits 130', async () => {
    const active = sinon.promise<{}>();
    const deploy = sandbox.stub(deployer, 'deployContracts').returns(active);
    const listeners = process.listeners('SIGINT');
    const running = exitCode();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const interrupt = process
      .listeners('SIGINT')
      .find((listener) => !listeners.includes(listener));
    if (!interrupt) throw new Error('Interrupt handler was not installed');
    interrupt('SIGINT');
    interrupt('SIGINT');
    expect(deploy.calledOnce).to.equal(true);
    expect(process.exit).not.to.have.property('called', true);
    void active.resolve({});
    expect(await running).to.equal(130);
    expect(deploy.calledOnce).to.equal(true);
    expect(process.listeners('SIGINT')).to.deep.equal(listeners);
  });

  it('retains timed-out deployment ownership until late work settles', async () => {
    const clock = sandbox.useFakeTimers();
    const active = sinon.promise<{}>();
    sandbox.stub(deployer, 'deployContracts').returns(active);
    deployer.chainTimeoutMs = 10;
    const run: DeploymentRun = { status: {}, interrupted: false };
    const settled = sandbox.stub();
    const deploying = baseDeploy(
      { test1: {} },
      deployer,
      multiProvider,
      false,
      settled,
      run,
    );
    await clock.tickAsync(10);
    expect(run.status.test1).to.equal(DeployStatus.FAILURE);
    expect(settled.called).to.equal(false);
    void active.resolve({});
    await deploying;
    expect(settled.calledOnce).to.equal(true);
    expect(deployer.deployedContracts).to.have.property('test1');
    expect(run.status.test1).to.equal(DeployStatus.FAILURE);
  });
});
