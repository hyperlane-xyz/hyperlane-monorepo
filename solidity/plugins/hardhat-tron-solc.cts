/**
 * Minimal Hardhat plugin that swaps the Solidity compiler for tron-solc.
 * Replaces @layerzerolabs/hardhat-tron — we only need the compiler swap,
 * not its deployment/signer/network features.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { subtask } from 'hardhat/config';
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
} from 'hardhat/builtin-tasks/task-names';

const TRON_SOLC_BASE_URL =
  'https://tronsuper.github.io/tron-solc-bin/bin/soljson_v';

// SHA-256 checksums of known tron-solc binaries.
// To add a new version: download the .js file and run `shasum -a 256 <file>`.
const TRON_SOLC_SHA256: Record<string, string> = {
  '0.8.22':
    '246b2a0f2e5f7e9611cbf91558a57b14958c9d0120740432a0f409e86d93d131',
};

function getTronSolcPath(version: string): string {
  return path.join(os.homedir(), '.tron', 'solc', `soljson_v${version}.js`);
}

function verifySha256(buffer: Buffer, expectedHash: string): void {
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (actual !== expectedHash) {
    throw new Error(
      `tron-solc checksum mismatch!\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${actual}\n` +
        `The downloaded binary may have been tampered with.`,
    );
  }
}

async function downloadTronSolc(
  version: string,
  dest: string,
): Promise<void> {
  const expectedHash = TRON_SOLC_SHA256[version];
  if (!expectedHash) {
    throw new Error(
      `No known SHA-256 checksum for tron-solc ${version}. ` +
        `Add it to TRON_SOLC_SHA256 in hardhat-tron-solc.cts before using this version.`,
    );
  }

  const url = `${TRON_SOLC_BASE_URL}${version}.js`;
  console.log(`Downloading tron-solc ${version} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download tron-solc: ${res.status} ${res.statusText}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  verifySha256(buffer, expectedHash);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  console.log(`tron-solc ${version} saved to ${dest}`);
}

subtask(
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  async ({ solcVersion }: { solcVersion: string }) => {
    const compilerPath = getTronSolcPath(solcVersion);

    if (!fs.existsSync(compilerPath)) {
      await downloadTronSolc(solcVersion, compilerPath);
    } else {
      // Verify cached binary integrity
      const expectedHash = TRON_SOLC_SHA256[solcVersion];
      if (expectedHash) {
        verifySha256(fs.readFileSync(compilerPath), expectedHash);
      }
    }

    // Verify the compiler loads and extract its version
    const solcWrapper = require('solc/wrapper');
    const solcModule = solcWrapper(require(compilerPath));
    const longVersion: string = solcModule.version();

    return {
      compilerPath,
      isSolcJs: true,
      version: solcVersion,
      longVersion,
    };
  },
);

// Force solcjs mode — prevent hardhat from using native solc binary
subtask(TASK_COMPILE_SOLIDITY_RUN_SOLC, async (args: any, _, runSuper) => {
  if (args.solcJsPath != null) {
    return runSuper(args);
  }
  throw new Error(
    'tron-solc: native solc is not supported. This should not happen — ' +
      'TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD must set isSolcJs: true.',
  );
});
