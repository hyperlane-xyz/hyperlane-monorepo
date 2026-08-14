import { readFileSync, statSync } from 'fs';

import {
  type TurnkeyConfig,
  TurnkeyConfigSchema,
  TurnkeyEvmSigner,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

export function readTurnkeyConfig(configPath: string): TurnkeyConfig {
  const stat = statSync(configPath);
  assert(stat.isFile(), `Turnkey config is not a file: ${configPath}`);
  if (process.platform !== 'win32') {
    assert(
      (stat.mode & 0o077) === 0,
      `Turnkey config permissions are too broad: ${configPath}. Run chmod 600 ${configPath}`,
    );
  }

  return TurnkeyConfigSchema.parse(
    JSON.parse(readFileSync(configPath, 'utf8')),
  );
}

export async function loadTurnkeyEvmSigner(
  configPath: string,
): Promise<TurnkeyEvmSigner> {
  const signer = new TurnkeyEvmSigner(readTurnkeyConfig(configPath));
  assert(await signer.healthCheck(), 'Turnkey health check failed');
  return signer;
}
