/**
 * Minimal Hardhat plugin that swaps the Solidity compiler for tron-solc.
 * Replaces @layerzerolabs/hardhat-tron — we only need the compiler swap,
 * not its deployment/signer/network features.
 */
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

function getTronSolcPath(version: string): string {
  return path.join(os.homedir(), '.tron', 'solc', `soljson_v${version}.js`);
}

async function downloadTronSolc(
  version: string,
  dest: string,
): Promise<void> {
  const url = `${TRON_SOLC_BASE_URL}${version}.js`;
  console.log(`Downloading tron-solc ${version} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download tron-solc: ${res.status} ${res.statusText}`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  console.log(`tron-solc ${version} saved to ${dest}`);
}

subtask(
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  async ({ solcVersion }: { solcVersion: string }) => {
    const compilerPath = getTronSolcPath(solcVersion);

    if (!fs.existsSync(compilerPath)) {
      await downloadTronSolc(solcVersion, compilerPath);
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
