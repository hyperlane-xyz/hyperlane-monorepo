import { expect } from 'chai';
import sinon from 'sinon';

import { MultiProvider } from '../providers/MultiProvider.js';
import type { ChainName } from '../types.js';

import {
  HyperlaneDeployer,
  type DeployerOptions,
} from './HyperlaneDeployer.js';

class ControlledDeployer extends HyperlaneDeployer<
  null,
  Record<string, never>
> {
  constructor(
    multiProvider: MultiProvider,
    private readonly deployChain: (
      chain: ChainName,
    ) => Promise<Record<string, never>>,
    options: DeployerOptions,
  ) {
    super(multiProvider, {}, options);
  }

  override deployContracts(chain: ChainName): Promise<Record<string, never>> {
    return this.deployChain(chain);
  }
}

describe('HyperlaneDeployer operation ownership', () => {
  let sandbox: sinon.SinonSandbox;
  let clock: sinon.SinonFakeTimers;
  let multiProvider: MultiProvider;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
    multiProvider = MultiProvider.createTestMultiProvider();
    sandbox
      .stub(multiProvider, 'tryGetExplorerAddressUrl')
      .resolves('https://example.com/address');
    sandbox
      .stub(multiProvider, 'getSignerAddress')
      .resolves('0x1111111111111111111111111111111111111111');
  });

  afterEach(() => sandbox.restore());

  it('accounts for signer setup rejection and drains admitted concurrent siblings', async () => {
    sandbox.restore();
    sandbox = sinon.createSandbox();
    clock = sandbox.useFakeTimers();
    multiProvider = MultiProvider.createTestMultiProvider();
    sandbox
      .stub(multiProvider, 'tryGetExplorerAddressUrl')
      .resolves('https://example.com/address');
    sandbox.stub(multiProvider, 'getSignerAddress').callsFake(async (chain) => {
      if (chain === 'test1') throw new Error('Signer missing');
      return '0x1111111111111111111111111111111111111111';
    });
    let finishSibling: () => void = () => {
      throw new Error('Sibling not started');
    };
    const deployer = new ControlledDeployer(
      multiProvider,
      () =>
        new Promise((resolve) => {
          finishSibling = () => resolve({});
        }),
      { concurrentDeploy: true },
    );
    let settled = false;
    const result = Promise.allSettled([
      deployer.deploy({ test1: null, test2: null }),
    ]).then((outcome) => {
      settled = true;
      return outcome;
    });
    await clock.tickAsync(0);
    expect(settled).to.be.false;
    finishSibling();
    const [outcome] = await result;
    expect(outcome.status).to.equal('rejected');
    if (outcome.status === 'rejected') {
      const error: unknown = outcome.reason;
      expect(error instanceof Error && error.message).to.include('test1');
    }
    expect(deployer.deployedContracts).to.have.property('test2');
    expect(deployer.deployedContracts).not.to.have.property('test1');
  });

  it('drains a timed-out deployment before rejecting and retains its late artifacts', async () => {
    let finishDeployment: () => void = () => {
      throw new Error('Deployment not started');
    };
    const deployer = new ControlledDeployer(
      multiProvider,
      () =>
        new Promise((resolve) => {
          finishDeployment = () => resolve({});
        }),
      { chainTimeoutMs: 10 },
    );
    let settled = false;
    const result = Promise.allSettled([deployer.deploy({ test1: null })]).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
    );
    await clock.tickAsync(10);
    expect(settled).to.be.false;
    finishDeployment();
    const [outcome] = await result;
    expect(outcome.status).to.equal('rejected');
    expect(deployer.deployedContracts).to.have.property('test1');
    expect(clock.countTimers()).to.equal(0);
  });
});
