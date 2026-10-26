import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { expect } from 'chai';
import childProcess from 'child_process';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import sinon from 'sinon';

import { AgentSignerKeyType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { Contexts } from '../config/contexts.js';
import { agents } from '../config/environments/mainnet3/agent.js';
import { AgentCli } from '../scripts/agents/utils.js';
import { AgentGCPKey } from '../src/agents/gcp.js';
import { AgentGcpKmsKey } from '../src/agents/gcp-kms/kms-key.js';
import { ValidatorAgentGcpUser } from '../src/agents/gcp-kms/validator-user.js';
import { ValidatorHelmManager } from '../src/agents/index.js';
import {
  persistProvisionedValidatorAddresses,
  validatorAddressesForChains,
} from '../src/agents/key-utils.js';
import type { CloudAgentKey } from '../src/agents/keys.js';
import type { HelmRootAgentValues } from '../src/config/agent/agent.js';
import {
  CheckpointSyncerType,
  ValidatorConfigHelper,
} from '../src/config/agent/validator.js';
import { Role } from '../src/roles.js';
import { getAWValidatorsPath } from '../src/paths.js';
import {
  HelmCommand,
  HelmManager,
  type HelmValues,
} from '../src/utils/helm.js';

const config = agents[Contexts.Hyperlane];

function helmValues(): HelmRootAgentValues {
  return {
    image: { repository: 'ghcr.io/hyperlane-xyz/hyperlane-agent', tag: 'test' },
    serviceAccount: {
      name: 'ethereum-validator',
      annotations: {
        'iam.gke.io/gcp-service-account':
          'validator@test.iam.gserviceaccount.com',
      },
    },
    hyperlane: {
      runEnv: 'mainnet3',
      context: Contexts.Hyperlane,
      aws: false,
      chains: [{ name: 'ethereum' }],
      validator: {
        enabled: true,
        configs: [
          {
            originChainName: 'ethereum',
            validator: {
              type: AgentSignerKeyType.Gcp,
              keyVersionName: 'projects/test/cryptoKeyVersions/1',
            },
            checkpointSyncer: {
              type: CheckpointSyncerType.Gcs,
              bucket: 'test-checkpoints',
              folder: 'ethereum',
            },
          },
        ],
      },
    },
  };
}

class SnapshotValidator extends ValidatorHelmManager {
  proposed = helmValues();
  deployed: HelmValues | null = helmValues();
  renders = 0;
  readError?: Error;
  missingKeys: string[] = [];

  constructor() {
    super(config, 'ethereum');
  }

  override async helmValues(): Promise<HelmRootAgentValues> {
    this.renders++;
    return this.proposed;
  }

  override async getKeysToCreate(): Promise<string[]> {
    return this.missingKeys;
  }

  override async getDeployedHelmValues(options?: {
    throwOnError?: boolean;
  }): Promise<HelmValues | null> {
    expect(options?.throwOnError).to.equal(true);
    if (this.readError) throw this.readError;
    return this.deployed;
  }

  get validatorConfig() {
    return this.config;
  }
}

class PreflightCli extends AgentCli {
  approvals: string[][] = [];
  keyApprovals: string[][] = [];
  approve = false;

  async check(manager: SnapshotValidator): Promise<boolean> {
    return this.runPreflightChecks({ validator: manager });
  }

  protected override async confirmResourceProvisioning(
    releases: string[],
    keysToCreate: string[],
  ): Promise<boolean> {
    this.approvals.push(releases);
    this.keyApprovals.push(keysToCreate);
    return this.approve;
  }
}

describe('GCP validator redeployment', () => {
  afterEach(() => {
    sinon.restore();
    syncBuiltinESMExports();
  });

  it('reports key-only changes even when the image and chain are unchanged', async () => {
    const manager = new SnapshotValidator();
    const entry = manager.proposed.hyperlane.validator?.configs?.[0];
    assert(entry, 'Expected validator config');
    entry.validator = {
      type: AgentSignerKeyType.Gcp,
      keyVersionName: 'projects/test/cryptoKeyVersions/2',
    };

    const diff = await manager.getPreflightDiff();
    expect(diff.imageDiff.hasChanges).to.equal(false);
    expect(diff.chainDiff.hasChanges).to.equal(false);
    expect(diff.resourceChanges).to.deep.equal(['Validator 0 signing key']);
  });

  it('reports service-account, storage, and additional-index changes', async () => {
    const manager = new SnapshotValidator();
    manager.proposed.serviceAccount = { name: 'replacement' };
    const configs = manager.proposed.hyperlane.validator?.configs;
    assert(configs?.[0], 'Expected validator config');
    configs[0].checkpointSyncer = {
      type: CheckpointSyncerType.Gcs,
      bucket: 'replacement',
    };
    configs.push(structuredClone(configs[0]));

    const diff = await manager.getPreflightDiff();
    expect(diff.resourceChanges).to.include.members([
      'Service account / Workload Identity',
      'Validator 0 checkpoint storage',
      'Validator 1 signing key',
      'Validator 1 checkpoint storage',
    ]);
  });

  it('aborts preflight when deployed values cannot be read', async () => {
    const manager = new SnapshotValidator();
    manager.readError = new Error('permission denied');
    await manager.getPreflightDiff().then(
      () => expect.fail('Preflight should fail'),
      (error: unknown) => expect(error).to.equal(manager.readError),
    );
    expect(manager.renders).to.equal(0);
    sinon.stub(console, 'log');
    const cli = new PreflightCli();
    cli.skipConfirmation = true;
    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([]);
  });

  it('requires resource confirmation even with --yes', async () => {
    sinon.stub(console, 'log');
    const manager = new SnapshotValidator();
    manager.deployed = null;
    manager.missingKeys = ['hyperlane-mainnet3-key-validator-0'];
    const cli = new PreflightCli();
    cli.skipConfirmation = true;

    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([[manager.helmReleaseName]]);
    expect(cli.keyApprovals).to.deep.equal([manager.missingKeys]);
    cli.approve = true;
    expect(await cli.check(manager)).to.equal(true);
  });

  it('requires confirmation for resource-only changes on an existing release', async () => {
    sinon.stub(console, 'log');
    const manager = new SnapshotValidator();
    const entry = manager.proposed.hyperlane.validator?.configs?.[0];
    assert(entry, 'Expected validator config');
    entry.chainSigner = { type: AgentSignerKeyType.Hex };
    const diff = await manager.getPreflightDiff();
    expect(diff.resourceChanges).to.deep.equal(['Validator 0 chain signer']);
    const cli = new PreflightCli();
    cli.skipConfirmation = true;

    expect(await cli.check(manager)).to.equal(false);
    expect(cli.approvals).to.deep.equal([[manager.helmReleaseName]]);
  });

  it('reuses resources and renders once for an image-only upgrade', async () => {
    const manager = new SnapshotValidator();
    manager.proposed.image.tag = 'replacement';
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves();
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);

    expect(provision.called).to.equal(false);
    expect(manager.renders).to.equal(1);
    expect(install.firstCall.args[2]).to.equal(manager.proposed);
  });

  it('refuses unconfirmed provisioning before touching cloud resources', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves();
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade).then(
      () => expect.fail('Provisioning should require confirmation'),
      (error: unknown) => {
        expect(error).to.be.instanceOf(Error);
        assert(error instanceof Error, 'Expected error');
        expect(error.message).to.contain('require confirmation');
      },
    );
    expect(provision.called).to.equal(false);
    expect(install.called).to.equal(false);
  });

  it('provisions an approved new release before Helm', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves();
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, {
      allowResourceProvisioning: true,
    });

    expect(
      provision.calledOnceWith(manager.namespace, manager.helmReleaseName),
    ).to.equal(true);
    expect(provision.calledBefore(install)).to.equal(true);
    expect(install.calledOnce).to.equal(true);
    expect(manager.renders).to.equal(1);
  });

  it('does not provision during a dry run', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const provision = sinon
      .stub(manager.validatorConfig, 'provisionGcpResources')
      .resolves();
    sinon.stub(HelmManager.prototype, 'runHelmCommand').resolves();

    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, {
      dryRun: true,
    });

    expect(provision.called).to.equal(false);
    expect(manager.renders).to.equal(1);
  });

  it('maps a shared KMS key to only the deployed chains', () => {
    const key = new AgentGcpKmsKey(config, Role.Validator, 0);
    key.remoteKey = {
      fetched: true,
      address: '0x0000000000000000000000000000000000000001',
    };
    expect(
      validatorAddressesForChains(config, [key], ['ethereum', 'solanamainnet']),
    ).to.deep.equal({
      ethereum: { validators: [key.address] },
      solanamainnet: { validators: [key.address] },
    });
  });

  it('serializes address merges and recovers after a failed secret write', async () => {
    const kms = new AgentGcpKmsKey(config, Role.Validator, 0);
    kms.remoteKey = {
      fetched: true,
      address: '0x0000000000000000000000000000000000000001',
    };
    const signer = new AgentGCPKey(
      'mainnet3',
      Contexts.Hyperlane,
      Role.Validator,
      'solanamainnet',
      0,
      {
        fetched: true,
        privateKey: 'unused',
        address: '0x0000000000000000000000000000000000000002',
      },
    );
    const untouched = {
      validators: ['0x0000000000000000000000000000000000000003'],
    };
    let local = JSON.stringify({ untouched });
    const filePath = getAWValidatorsPath(config.runEnv, config.context);
    const read = sinon.stub(fs, 'readFileSync').callThrough();
    read.withArgs(filePath, 'utf8').callsFake(() => local);
    const write = sinon.stub(fs, 'writeFileSync').callThrough();
    write.withArgs(filePath).callsFake((_path, data) => {
      local = String(data);
    });
    // Mock formatter/project-number subprocesses; all cloud calls stay stubbed.
    sinon.stub(childProcess, 'exec').yields(null, '123', '');
    syncBuiltinESMExports();

    const existing = [
      { identifier: 'unrelated-relayer', address: untouched.validators[0] },
    ];
    const access = sinon.stub(
      SecretManagerServiceClient.prototype,
      'accessSecretVersion',
    );
    access
      .onFirstCall()
      .resolves([{ payload: { data: Buffer.from(JSON.stringify(existing)) } }]);
    access
      .onSecondCall()
      .resolves([{ payload: { data: Buffer.from(JSON.stringify(existing)) } }]);
    access.onThirdCall().resolves([
      {
        payload: {
          data: Buffer.from(
            JSON.stringify([...existing, kms.serializeAsAddress()]),
          ),
        },
      },
    ]);
    sinon
      .stub(SecretManagerServiceClient.prototype, 'listSecrets')
      .resolves([[{}]]);
    const save = sinon.stub(
      SecretManagerServiceClient.prototype,
      'addSecretVersion',
    );
    const error = new Error('Secret write failed');
    save.onFirstCall().rejects(error);
    save.resolves([{}]);

    await persistProvisionedValidatorAddresses(
      config,
      [kms],
      ['ethereum'],
    ).then(
      () => expect.fail('Secret write should fail'),
      (caught: unknown) => expect(caught).to.equal(error),
    );
    await Promise.all([
      persistProvisionedValidatorAddresses(config, [kms], ['ethereum']),
      persistProvisionedValidatorAddresses(
        config,
        [kms, signer],
        ['solanamainnet'],
      ),
    ]);
    expect(JSON.parse(local)).to.deep.equal({
      untouched,
      ethereum: { validators: [kms.address] },
      solanamainnet: { validators: [kms.address] },
    });
    const data = save.lastCall.args[0]?.payload?.data;
    assert(data, 'Expected secret payload');
    expect(
      JSON.parse(
        typeof data === 'string' ? data : Buffer.from(data).toString(),
      ),
    ).to.deep.equal([
      ...existing,
      kms.serializeAsAddress(),
      signer.serializeAsAddress(),
    ]);
  });

  it('persists keys before IAM, including when IAM fails', async () => {
    const helper = new ValidatorConfigHelper(config, 'ethereum');
    const create = sinon
      .stub(AgentGcpKmsKey.prototype, 'createIfNotExists')
      .resolves();
    const persist = sinon.stub<[CloudAgentKey[]], Promise<void>>().resolves();
    const error = new Error('IAM permission denied');
    const iam = sinon
      .stub(ValidatorAgentGcpUser.prototype, 'createServiceAccountIfNotExists')
      .rejects(error);

    await helper.provisionGcpResources('namespace', 'release', persist).then(
      () => expect.fail('IAM should fail'),
      (caught: unknown) => expect(caught).to.equal(error),
    );
    expect(persist.calledOnce).to.equal(true);
    expect(create.calledBefore(persist)).to.equal(true);
    expect(persist.calledBefore(iam)).to.equal(true);
    expect(
      persist.firstCall.args[0].map((key) => key.identifier),
    ).to.deep.equal(['hyperlane-mainnet3-key-validator-0']);
  });

  it('retries persistence before provisioning IAM', async () => {
    const helper = new ValidatorConfigHelper(config, 'ethereum');
    sinon.stub(AgentGcpKmsKey.prototype, 'createIfNotExists').resolves();
    const persist = sinon.stub<[CloudAgentKey[]], Promise<void>>();
    const error = new Error('Secret write failed');
    persist.onFirstCall().rejects(error);
    persist.onSecondCall().resolves();
    const iamError = new Error('Stop before cloud calls');
    const iam = sinon
      .stub(ValidatorAgentGcpUser.prototype, 'createServiceAccountIfNotExists')
      .rejects(iamError);

    await helper.provisionGcpResources('namespace', 'release', persist).then(
      () => expect.fail('Persistence should fail'),
      (caught: unknown) => expect(caught).to.equal(error),
    );
    expect(iam.called).to.equal(false);
    await helper.provisionGcpResources('namespace', 'release', persist).then(
      () => expect.fail('IAM should fail'),
      (caught: unknown) => expect(caught).to.equal(iamError),
    );
    expect(persist.calledTwice).to.equal(true);
    expect(iam.calledOnce).to.equal(true);
  });

  it('does not run Helm after a provisioning or persistence error', async () => {
    const manager = new SnapshotValidator();
    manager.deployed = null;
    const error = new Error('Secret write failed');
    sinon.stub(manager.validatorConfig, 'provisionGcpResources').rejects(error);
    const install = sinon
      .stub(HelmManager.prototype, 'runHelmCommand')
      .resolves();

    await manager
      .runHelmCommand(HelmCommand.InstallOrUpgrade, {
        allowResourceProvisioning: true,
      })
      .then(
        () => expect.fail('Persistence should fail'),
        (caught: unknown) => expect(caught).to.equal(error),
      );
    expect(install.called).to.equal(false);
  });

  it('waits for running siblings and preserves the first deployment error', async () => {
    sinon.stub(console, 'log');
    const cli = new (class extends AgentCli {
      protected override async init() {
        this.roles = [Role.Validator];
        this.agentConfig = config;
        this.chains = ['ethereum', 'solanamainnet', 'starknet'];
        this.concurrency = 2;
      }
    })();
    const firstError = new Error('First deployment failed');
    let releaseSibling: (() => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const deploy = sinon
      .stub(ValidatorHelmManager.prototype, 'runHelmCommand')
      .callsFake(async function (this: ValidatorHelmManager) {
        if (this.chainName === 'ethereum') throw firstError;
        assert(notifyStarted, 'Expected start notification');
        notifyStarted();
        await gate;
        throw new Error('Sibling deployment failed');
      });
    const maxListeners = process.getMaxListeners();
    let finished = false;
    const result = cli.runHelmCommand(HelmCommand.Remove).then(
      () => expect.fail('Deployment should fail'),
      (caught: unknown) => {
        finished = true;
        expect(caught).to.equal(firstError);
      },
    );
    await started;
    await Promise.resolve();
    expect(finished).to.equal(false);
    assert(releaseSibling, 'Expected sibling release');
    releaseSibling();
    await result;
    expect(deploy.calledTwice).to.equal(true);
    expect(process.getMaxListeners()).to.equal(maxListeners);
  });

  it('checks the manually provisioned Starknet key before IAM', async () => {
    const helper = new ValidatorConfigHelper(config, 'starknet');
    sinon.stub(AgentGcpKmsKey.prototype, 'createIfNotExists').resolves();
    const error = new Error('Starknet key missing');
    const check = sinon
      .stub(AgentGCPKey.prototype, 'createIfNotExists')
      .rejects(error);
    const persist = sinon.stub<[CloudAgentKey[]], Promise<void>>().resolves();
    const iam = sinon
      .stub(ValidatorAgentGcpUser.prototype, 'createServiceAccountIfNotExists')
      .resolves('unused');

    await helper.provisionGcpResources('namespace', 'release', persist).then(
      () => expect.fail('Missing Starknet key should fail'),
      (caught: unknown) => expect(caught).to.equal(error),
    );
    expect(check.calledOnce).to.equal(true);
    expect(iam.called).to.equal(false);
  });

  it('reuses shared KMS keys and lists only missing transaction keys', async () => {
    sinon.stub(AgentGcpKmsKey.prototype, 'exists').resolves(true);
    sinon.stub(AgentGCPKey.prototype, 'exists').resolves(false);
    expect(
      await new ValidatorHelmManager(config, 'ethereum').getKeysToCreate(),
    ).to.deep.equal([]);
    expect(
      await new ValidatorHelmManager(config, 'solanamainnet').getKeysToCreate(),
    ).to.deep.equal(['hyperlane-mainnet3-key-solanamainnet-validator-0']);
    expect(
      await new ValidatorHelmManager(config, 'starknet').getKeysToCreate(),
    ).to.deep.equal([]);
  });

  for (const message of ['PERMISSION_DENIED', 'UNAVAILABLE', 'Invalid JSON']) {
    it(`does not replace a transaction signer on ${message}`, async () => {
      const key = new AgentGCPKey(
        'mainnet3',
        Contexts.Hyperlane,
        Role.Validator,
        'solanamainnet',
        0,
      );
      const error = new Error(message);
      sinon.stub(key, 'fetch').rejects(error);
      const create = sinon.stub(key, 'create').resolves();
      for (const operation of [
        () => key.createIfNotExists(),
        () => key.exists(),
      ]) {
        await operation().then(
          () => expect.fail('Read failure should propagate'),
          (caught: unknown) => expect(caught).to.equal(error),
        );
      }
      expect(create.called).to.equal(false);
    });
  }

  it('creates a transaction signer only when it is missing', async () => {
    const key = new AgentGCPKey(
      'mainnet3',
      Contexts.Hyperlane,
      Role.Validator,
      'solanamainnet',
      0,
    );
    sinon.stub(key, 'fetch').rejects(new Error('NOT_FOUND'));
    const create = sinon.stub(key, 'create').resolves();
    expect(await key.exists()).to.equal(false);
    await key.createIfNotExists();
    expect(create.calledOnce).to.equal(true);
  });

  it('fails when a manually provisioned Starknet transaction key is missing', async () => {
    const key = new AgentGCPKey(
      'mainnet3',
      Contexts.Hyperlane,
      Role.Validator,
      'starknet',
      0,
    );
    sinon.stub(key, 'fetch').rejects(new Error('NOT_FOUND'));

    await key.createIfNotExists().then(
      () => expect.fail('Starknet requires an existing key'),
      (error: unknown) => {
        assert(error instanceof Error, 'Expected error');
        expect(error.message).to.contain(
          'Starknet keys must be manually added',
        );
      },
    );
  });
});
