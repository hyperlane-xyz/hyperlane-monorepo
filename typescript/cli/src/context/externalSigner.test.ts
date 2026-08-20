import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';
import sinon from 'sinon';

import { TurnkeyEvmSigner } from '@hyperlane-xyz/sdk';

import {
  ExternalSignerType,
  loadExternalEvmSigner,
  readExternalSignerConfig,
} from './externalSigner.js';

const tempDirs: string[] = [];
const config = {
  type: ExternalSignerType.TURNKEY,
  organizationId: 'organization-id',
  apiPublicKey: 'api-public-key',
  apiPrivateKey: 'api-private-key',
  privateKeyId: 'private-key-id',
  publicKey: '0x0000000000000000000000000000000000000001',
};

describe('externalSigner', () => {
  afterEach(() => {
    sinon.restore();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it('reads a private Turnkey config', () => {
    const path = writeConfig(0o600, config);
    expect(readExternalSignerConfig(path)).to.deep.equal(config);
  });

  it('rejects group-readable config files', () => {
    if (process.platform === 'win32') return;
    const path = writeConfig(0o640, config);
    expect(() => readExternalSignerConfig(path)).to.throw(
      'permissions are too broad',
    );
  });

  it('rejects unsupported signer types', () => {
    const path = writeConfig(0o600, { ...config, type: 'privy' });
    expect(() => readExternalSignerConfig(path)).to.throw();
  });

  it('rejects a non-EVM Turnkey public key', () => {
    const path = writeConfig(0o600, { ...config, publicKey: 'not-an-address' });
    expect(() => readExternalSignerConfig(path)).to.throw(
      'Turnkey publicKey must be a valid EVM address',
    );
  });

  it('rejects an unhealthy Turnkey signer', async () => {
    const path = writeConfig(0o600, config);
    sinon.stub(TurnkeyEvmSigner.prototype, 'healthCheck').resolves(false);

    let error: Error | undefined;
    try {
      await loadExternalEvmSigner(path);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).to.include('Turnkey health check failed');
  });
});

function writeConfig(mode: number, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hyperlane-external-signer-'));
  tempDirs.push(dir);
  const path = join(dir, 'signer.json');
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}
