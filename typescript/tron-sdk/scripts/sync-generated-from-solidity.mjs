import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tronSdkDir = resolve(scriptDir, '..');
const solidityTronArtifactsDir = resolve(tronSdkDir, '../../solidity/artifacts-tron');
const solidityTronTypechainDir = join(solidityTronArtifactsDir, 'typechain');
const tronSdkAbiDir = join(tronSdkDir, 'src/abi');
const tronSdkTypechainDir = join(tronSdkDir, 'src/typechain');

if (
  !existsSync(solidityTronArtifactsDir) ||
  !existsSync(solidityTronTypechainDir)
) {
  throw new Error(
    `Missing Solidity Tron artifacts at ${solidityTronArtifactsDir}. Run "pnpm -C solidity build:tron" first.`,
  );
}

rmSync(tronSdkAbiDir, { recursive: true, force: true });
mkdirSync(tronSdkAbiDir, { recursive: true });

for (const entry of readdirSync(solidityTronArtifactsDir)) {
  if (entry === 'typechain') continue;
  cpSync(join(solidityTronArtifactsDir, entry), join(tronSdkAbiDir, entry), {
    recursive: true,
    force: true,
  });
}

rmSync(tronSdkTypechainDir, { recursive: true, force: true });
cpSync(solidityTronTypechainDir, tronSdkTypechainDir, {
  recursive: true,
  force: true,
});
