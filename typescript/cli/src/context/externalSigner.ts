import { readFileSync, statSync } from 'fs';

import { type Signer } from 'ethers';
import { z } from 'zod';

import { TurnkeyConfigSchema, TurnkeyEvmSigner } from '@hyperlane-xyz/sdk';
import { assert, isValidAddressEvm } from '@hyperlane-xyz/utils';

export const ExternalSignerType = {
  TURNKEY: 'turnkey',
} as const;

const TurnkeyExternalSignerConfigSchema = TurnkeyConfigSchema.extend({
  type: z.literal(ExternalSignerType.TURNKEY),
  publicKey: TurnkeyConfigSchema.shape.publicKey.refine(
    isValidAddressEvm,
    'Turnkey publicKey must be a valid EVM address',
  ),
});

export const ExternalSignerConfigSchema = z.discriminatedUnion('type', [
  TurnkeyExternalSignerConfigSchema,
]);

export type ExternalSignerConfig = z.infer<typeof ExternalSignerConfigSchema>;

export function readExternalSignerConfig(
  configPath: string,
): ExternalSignerConfig {
  const stat = statSync(configPath);
  assert(stat.isFile(), `External signer config is not a file: ${configPath}`);
  if (process.platform !== 'win32') {
    assert(
      (stat.mode & 0o077) === 0,
      `External signer config permissions are too broad: ${configPath}. Run chmod 600 ${configPath}`,
    );
  }

  return ExternalSignerConfigSchema.parse(
    JSON.parse(readFileSync(configPath, 'utf8')),
  );
}

export async function loadExternalEvmSigner(
  configPath: string,
): Promise<Signer> {
  const config = readExternalSignerConfig(configPath);

  switch (config.type) {
    case ExternalSignerType.TURNKEY: {
      const signer = new TurnkeyEvmSigner(config);
      assert(await signer.healthCheck(), 'Turnkey health check failed');
      return signer;
    }
  }
}
