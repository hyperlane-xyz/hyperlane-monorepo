import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { expect } from 'chai';
import childProcess from 'child_process';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { rejects } from 'node:assert/strict';
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
  type KeyAsAddress,
} from '../src/agents/key-utils.js';
import type { HelmRootAgentValues } from '../src/config/agent/agent.js';
import {
  CheckpointSyncerType,
  ValidatorConfigHelper,
} from '../src/config/agent/validator.js';
import { getAWValidatorsPath } from '../src/paths.js';
import { Role } from '../src/roles.js';
import { HelmCommand, HelmManager } from '../src/utils/helm.js';

const config = agents[Contexts.Hyperlane];
const installOptions = { allowResourceProvisioning: true };

function setup() {
  const values: HelmRootAgentValues = {
    image: { repository: 'test', tag: 'test' },
    serviceAccount: { name: 'validator' },
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
              keyVersionName: 'keys/1',
            },
            checkpointSyncer: {
              type: CheckpointSyncerType.Gcs,
              bucket: 'checkpoints',
            },
          },
        ],
      },
    },
  };
  const manager = new ValidatorHelmManager(config, 'ethereum');
  const render = sinon.stub(manager, 'helmValues').resolves(values);
  const deployed = sinon
    .stub(manager, 'getDeployedHelmValues')
    .resolves(structuredClone(values));
  const missing = sinon.stub(manager, 'getKeysToCreate').resolves([]);
  const provision = sinon
    .stub(ValidatorConfigHelper.prototype, 'provisionGcpResources')
    .resolves();
  const install = sinon
    .stub(HelmManager.prototype, 'runHelmCommand')
    .resolves();
  const entries = values.hyperlane.validator?.configs;
  assert(entries?.[0], 'Expected validator config');
  return {
    manager,
    values,
    entry: entries[0],
    entries,
    render,
    deployed,
    missing,
    provision,
    install,
  };
}

class PreflightCli extends AgentCli {
  override skipConfirmation = true;
  override confirmResourceProvisioning = sinon
    .stub<[string[], string[]], Promise<boolean>>()
    .resolves(false);

  check(manager: ValidatorHelmManager) {
    return this.runPreflightChecks({ validator: manager });
  }
}

function transactionKey(chain = 'solanamainnet') {
  return new AgentGCPKey(
    'mainnet3',
    Contexts.Hyperlane,
    Role.Validator,
    chain,
    0,
  );
}

function mockPersistence() {
  const kms = new AgentGcpKmsKey(config, Role.Validator, 0);
  kms.remoteKey = {
    fetched: true,
    address: '0x0000000000000000000000000000000000000001',
  };
  const untouched = {
    validators: ['0x0000000000000000000000000000000000000003'],
  };
  let local = JSON.stringify({ untouched });
  const filePath = getAWValidatorsPath(config.runEnv, config.context);
  sinon
    .stub(fs, 'readFileSync')
    .callThrough()
    .withArgs(filePath, 'utf8')
    .callsFake(() => local);
  sinon
    .stub(fs, 'writeFileSync')
    .callThrough()
    .withArgs(filePath)
    .callsFake((_path, data) => {
      local = String(data);
    });
  sinon.stub(childProcess, 'exec').yields(null, '123', '');
  syncBuiltinESMExports();
  const existing = [
    { identifier: 'unrelated-relayer', address: untouched.validators[0] },
  ];
  const secret = (keys: KeyAsAddress[]) => [
    { payload: { data: Buffer.from(JSON.stringify(keys)) } },
  ];
  const access = sinon
    .stub(SecretManagerServiceClient.prototype, 'accessSecretVersion')
    .resolves(secret(existing));
  sinon
    .stub(SecretManagerServiceClient.prototype, 'listSecrets')
    .resolves([[{}]]);
  const save = sinon
    .stub(SecretManagerServiceClient.prototype, 'addSecretVersion')
    .resolves([{}]);
  return {
    kms,
    untouched,
    existing,
    access,
    save,
    secret,
    readLocal: () => JSON.parse(local),
  };
}

describe('GCP validator redeployment', () => {
  beforeEach(() => sinon.stub(console, 'log'));
  afterEach(() => {
    sinon.restore();
    syncBuiltinESMExports();
  });

  it('reports resource changes independently of the image and chain', async () => {
    const { manager, values, entry, entries } = setup();
    values.serviceAccount = { name: 'replacement' };
    entry.validator = {
      type: AgentSignerKeyType.Gcp,
      keyVersionName: 'keys/2',
    };
    entry.chainSigner = { type: AgentSignerKeyType.Hex };
    entry.checkpointSyncer = {
      type: CheckpointSyncerType.Gcs,
      bucket: 'replacement',
    };
    entries.push(structuredClone(entry));
    const diff = await manager.getPreflightDiff();
    expect(diff.imageDiff.hasChanges || diff.chainDiff.hasChanges).to.equal(
      false,
    );
    expect(diff.resourceChanges).to.include.members([
      'Service account / Workload Identity',
      'Validator 0 signing key',
      'Validator 0 chain signer',
      'Validator 0 checkpoint storage',
      'Validator 1 signing key',
      'Validator 1 checkpoint storage',
    ]);
  });

  it('fails preflight on deployed-value read errors', async () => {
    const { manager, deployed, render } = setup();
    const error = new Error('permission denied');
    deployed.rejects(error);
    await rejects(manager.getPreflightDiff(), error);
    await rejects(new PreflightCli().check(manager), error);
    expect(render.called).to.equal(false);
    expect(deployed.alwaysCalledWithExactly({ throwOnError: true })).to.equal(
      true,
    );
  });

  for (const newRelease of [true, false]) {
    it(`requires explicit resource approval with --yes (new release: ${newRelease})`, async () => {
      const { manager, deployed, missing, entry } = setup();
      if (newRelease) deployed.resolves(null);
      else entry.chainSigner = { type: AgentSignerKeyType.Hex };
      const keys = ['hyperlane-mainnet3-key-validator-0'];
      missing.resolves(keys);
      const cli = new PreflightCli();
      expect(await cli.check(manager)).to.equal(false);
      expect(
        cli.confirmResourceProvisioning.calledWithExactly(
          [manager.helmReleaseName],
          keys,
        ),
      ).to.equal(true);
      cli.confirmResourceProvisioning.resolves(true);
      expect(await cli.check(manager)).to.equal(true);
    });
  }

  it('reuses resources and renders once for an image-only upgrade', async () => {
    const { manager, values, provision, install, render } = setup();
    values.image.tag = 'replacement';
    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade);
    expect(provision.called).to.equal(false);
    expect(render.calledOnce).to.equal(true);
    expect(install.firstCall.args[2]).to.equal(values);
  });

  it('refuses unconfirmed provisioning and skips it during dry runs', async () => {
    const { manager, deployed, provision, install } = setup();
    deployed.resolves(null);
    await rejects(
      manager.runHelmCommand(HelmCommand.InstallOrUpgrade),
      /require confirmation/,
    );
    expect(install.called || provision.called).to.equal(false);
    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, {
      dryRun: true,
    });
    expect(provision.called).to.equal(false);
  });

  it('provisions approved changes before Helm', async () => {
    const { manager, deployed, provision, install } = setup();
    deployed.resolves(null);
    await manager.runHelmCommand(HelmCommand.InstallOrUpgrade, installOptions);
    expect(
      provision.calledOnceWithExactly(
        manager.namespace,
        manager.helmReleaseName,
      ),
    ).to.equal(true);
    expect(provision.calledBefore(install)).to.equal(true);
  });

  it('retries failed persistence before IAM and Helm', async () => {
    const { manager, deployed, provision, install } = setup();
    provision.restore();
    deployed.resolves(null);
    const { kms, save, readLocal, untouched } = mockPersistence();
    sinon.stub(ValidatorConfigHelper.prototype, 'keys').get(() => [kms]);
    sinon.stub(kms, 'createIfNotExists').resolves();
    const iamError = new Error('IAM permission denied');
    const iam = sinon
      .stub(ValidatorAgentGcpUser.prototype, 'createServiceAccountIfNotExists')
      .rejects(iamError);
    const writeError = new Error('Secret write failed');
    save.onFirstCall().rejects(writeError);
    await rejects(
      manager.runHelmCommand(HelmCommand.InstallOrUpgrade, installOptions),
      writeError,
    );
    expect(iam.called || install.called).to.equal(false);
    await rejects(
      manager.runHelmCommand(HelmCommand.InstallOrUpgrade, installOptions),
      iamError,
    );
    expect(save.calledTwice && save.calledBefore(iam)).to.equal(true);
    expect(install.called).to.equal(false);
    expect(readLocal()).to.deep.equal({
      untouched,
      ethereum: { validators: [kms.address] },
    });
  });

  it('serializes persistence and preserves untouched chains and roles', async () => {
    const { kms, existing, untouched, access, save, secret, readLocal } =
      mockPersistence();
    const signer = transactionKey();
    sinon.stub(signer, 'serializeAsAddress').returns({
      identifier: signer.identifier,
      address: untouched.validators[0],
    });
    access
      .onSecondCall()
      .resolves(secret([...existing, kms.serializeAsAddress()]));
    await Promise.all([
      persistProvisionedValidatorAddresses(config, 'ethereum', [kms]),
      persistProvisionedValidatorAddresses(config, 'solanamainnet', [
        kms,
        signer,
      ]),
    ]);
    expect(readLocal()).to.deep.equal({
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

  it('waits for started siblings and preserves the first error', async () => {
    const clock = sinon.useFakeTimers();
    const cli = new (class extends AgentCli {
      protected override async init() {
        this.roles = [Role.Validator];
        this.agentConfig = config;
        this.chains = ['ethereum', 'solanamainnet', 'starknet'];
        this.concurrency = 2;
      }
    })();
    const error = new Error('First deployment failed');
    let siblingFinished = false;
    const deploy = sinon
      .stub(ValidatorHelmManager.prototype, 'runHelmCommand')
      .callsFake(async function (this: ValidatorHelmManager) {
        if (this.chainName === 'ethereum') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
        siblingFinished = true;
        throw new Error('Sibling failed');
      });
    const result = cli
      .runHelmCommand(HelmCommand.Remove)
      .catch((caught: unknown) => ({ error: caught, siblingFinished }));
    await clock.tickAsync(10);
    expect(await result).to.deep.equal({ error, siblingFinished: true });
    expect(deploy.calledTwice).to.equal(true);
  });

  it('lists missing transaction keys while reusing shared KMS keys', async () => {
    sinon.stub(AgentGcpKmsKey.prototype, 'exists').resolves(true);
    sinon.stub(AgentGCPKey.prototype, 'exists').resolves(false);
    for (const chain of ['ethereum', 'solanamainnet', 'starknet']) {
      expect(
        await new ValidatorHelmManager(config, chain).getKeysToCreate(),
      ).to.deep.equal(
        chain === 'solanamainnet' ? [transactionKey().identifier] : [],
      );
    }
  });

  for (const message of ['PERMISSION_DENIED', 'UNAVAILABLE', 'Invalid JSON']) {
    it(`preserves transaction signers on ${message}`, async () => {
      const key = transactionKey();
      const error = new Error(message);
      sinon.stub(key, 'fetch').rejects(error);
      const create = sinon.stub(key, 'create').resolves();
      await rejects(key.createIfNotExists(), error);
      await rejects(key.exists(), error);
      expect(create.called).to.equal(false);
    });
  }

  it('creates only missing keys and requires manual Starknet keys', async () => {
    const key = transactionKey();
    sinon.stub(key, 'fetch').rejects(new Error('NOT_FOUND'));
    const create = sinon.stub(key, 'create').resolves();
    expect(await key.exists()).to.equal(false);
    await key.createIfNotExists();
    expect(create.calledOnce).to.equal(true);
    sinon.stub(AgentGcpKmsKey.prototype, 'createIfNotExists').resolves();
    sinon.stub(AgentGCPKey.prototype, 'fetch').rejects(new Error('NOT_FOUND'));
    await rejects(
      new ValidatorConfigHelper(config, 'starknet').provisionGcpResources(
        'namespace',
        'release',
      ),
      /Starknet keys must be manually added/,
    );
  });
});
