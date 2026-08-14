import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { expect } from 'chai';
import sinon from 'sinon';

import { TurnkeyEvmSigner } from '@hyperlane-xyz/sdk';

import { loadTurnkeyEvmSigner, readTurnkeyConfig } from './turnkey.js';

const tempDirs: string[] = [];

describe('readTurnkeyConfig', () => {
  const config = {
    organizationId: 'organization-id',
    apiPublicKey: 'api-public-key',
    apiPrivateKey: 'api-private-key',
    privateKeyId: 'private-key-id',
    publicKey: '0x0000000000000000000000000000000000000001',
  };

  afterEach(() => {
    sinon.restore();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it('reads a private JSON config', () => {
    const path = writeConfig(0o600, config);
    expect(readTurnkeyConfig(path)).to.deep.equal(config);
  });

  it('rejects group-readable config files', () => {
    if (process.platform === 'win32') return;
    const path = writeConfig(0o640, config);
    expect(() => readTurnkeyConfig(path)).to.throw(
      'Turnkey config permissions are too broad',
    );
  });

  it('rejects malformed config', () => {
    const path = writeConfig(0o600, { organizationId: 'organization-id' });
    expect(() => readTurnkeyConfig(path)).to.throw();
  });

  it('rejects an unhealthy Turnkey signer', async () => {
    const path = writeConfig(0o600, config);
    sinon.stub(TurnkeyEvmSigner.prototype, 'healthCheck').resolves(false);

    let error: Error | undefined;
    try {
      await loadTurnkeyEvmSigner(path);
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    expect(error?.message).to.include('Turnkey health check failed');
  });
});

function writeConfig(mode: number, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hyperlane-turnkey-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'turnkey.json');
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}
