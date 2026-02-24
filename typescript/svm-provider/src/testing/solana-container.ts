// eslint-disable-next-line import/no-nodejs-modules
import { type ChildProcess, execSync, spawn } from 'child_process';
// eslint-disable-next-line import/no-nodejs-modules
import * as fs from 'fs';
// eslint-disable-next-line import/no-nodejs-modules
import * as os from 'os';
// eslint-disable-next-line import/no-nodejs-modules
import * as path from 'path';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

export const SOLANA_VALIDATOR_IMAGE = 'anzaxyz/agave:v2.0.20';
export const SOLANA_RPC_PORT = 8899;

export function isAppleSilicon(): boolean {
  try {
    const arch = execSync('uname -m', { encoding: 'utf-8' }).trim();
    const osName = execSync('uname -s', { encoding: 'utf-8' }).trim();
    return osName === 'Darwin' && arch === 'arm64';
  } catch {
    return false;
  }
}

const MIN_SOLANA_VERSION = { major: 2, minor: 0 };

function parseVersion(
  version: string,
): { major: number; minor: number } | null {
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

function meetsMinVersion(
  version: { major: number; minor: number },
  min: { major: number; minor: number },
): boolean {
  if (version.major > min.major) return true;
  if (version.major === min.major && version.minor >= min.minor) return true;
  return false;
}

function getValidatorVersion(binaryPath: string): string | null {
  try {
    const output = execSync(`"${binaryPath}" --version`, {
      encoding: 'utf-8',
    });
    const match = output.match(/solana-test-validator\s+(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const SOLANA_BINARY_PATHS = [
  path.join(os.homedir(), '.local/share/solana/install/active_release/bin'),
  path.join(os.homedir(), '.local/share/solana/install/releases/2.1.0/bin'),
  path.join(os.homedir(), '.local/share/solana/install/releases/2.0.20/bin'),
  '/tmp/solana-release/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

export function findSolanaTestValidator(): string | null {
  const candidates: Array<{ path: string; version: string }> = [];

  for (const basePath of SOLANA_BINARY_PATHS) {
    const binaryPath = path.join(basePath, 'solana-test-validator');
    if (fs.existsSync(binaryPath)) {
      const version = getValidatorVersion(binaryPath);
      if (version) {
        candidates.push({ path: binaryPath, version });
      }
    }
  }

  try {
    const result = execSync('which solana-test-validator', {
      encoding: 'utf-8',
    }).trim();
    if (result && fs.existsSync(result)) {
      const version = getValidatorVersion(result);
      if (version && !candidates.some((c) => c.path === result)) {
        candidates.push({ path: result, version });
      }
    }
  } catch {
    // Not in PATH
  }

  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const parsed = parseVersion(candidate.version);
    if (parsed && meetsMinVersion(parsed, MIN_SOLANA_VERSION)) {
      return candidate.path;
    }
  }

  // eslint-disable-next-line no-console
  console.warn(
    `Warning: No Solana v${MIN_SOLANA_VERSION.major}.x found. ` +
      `Using ${candidates[0].version} which may have compatibility issues.`,
  );
  return candidates[0].path;
}

export interface PreloadedProgram {
  programId: string;
  soPath: string;
}

export interface SolanaValidatorConfig {
  image?: string;
  keepRunning?: boolean;
  validatorArgs?: string[];
  forceDocker?: boolean;
  binaryPath?: string;
  rpcPort?: number;
  preloadedPrograms?: PreloadedProgram[];
  platform?: string;
}

export interface SolanaTestValidator {
  rpcUrl: string;
  mode: 'local' | 'docker';
  stop(): Promise<void>;
  container?: StartedTestContainer;
  process?: ChildProcess;
}

export type SolanaTestContainer = SolanaTestValidator;

async function startLocalValidator(
  config: SolanaValidatorConfig,
): Promise<SolanaTestValidator> {
  const {
    binaryPath,
    keepRunning = false,
    validatorArgs = [],
    rpcPort = SOLANA_RPC_PORT,
    preloadedPrograms = [],
  } = config;

  const solanaPath = binaryPath ?? findSolanaTestValidator();
  if (!solanaPath) {
    throw new Error(
      'solana-test-validator binary not found. Install from https://docs.anza.xyz/cli/install',
    );
  }

  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solana-ledger-'));

  const bpfProgramArgs: string[] = [];
  for (const program of preloadedPrograms) {
    bpfProgramArgs.push('--bpf-program', program.programId, program.soPath);
  }

  const args = [
    '--rpc-port',
    String(rpcPort),
    '--ledger',
    ledgerDir,
    '--reset',
    ...bpfProgramArgs,
    ...validatorArgs,
  ];

  const proc = spawn(solanaPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for validator to start'));
    }, 120_000);

    const checkReady = (data: Buffer) => {
      output += data.toString();
      if (output.includes('JSON RPC URL:') || output.includes('RPC URL:')) {
        clearTimeout(timeout);
        resolve();
      }
    };

    proc.stdout?.on('data', checkReady);
    proc.stderr?.on('data', checkReady);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Validator exited with code ${code}: ${output}`));
      }
    });
  });

  return {
    rpcUrl,
    mode: 'local',
    process: proc,
    async stop() {
      if (!keepRunning && proc && !proc.killed) {
        proc.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }
      try {
        fs.rmSync(ledgerDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

async function startDockerValidator(
  config: SolanaValidatorConfig,
): Promise<SolanaTestValidator> {
  const {
    image = SOLANA_VALIDATOR_IMAGE,
    keepRunning = false,
    validatorArgs = [],
    rpcPort = SOLANA_RPC_PORT,
    preloadedPrograms = [],
    platform,
  } = config;

  const bpfProgramArgs: string[] = [];
  const hostDirToContainerDir = new Map<string, string>();
  let mountIndex = 0;

  for (const program of preloadedPrograms) {
    const hostDir = path.dirname(program.soPath);
    const fileName = path.basename(program.soPath);
    if (!hostDirToContainerDir.has(hostDir)) {
      hostDirToContainerDir.set(hostDir, `/programs/${mountIndex++}`);
    }
    const containerDir = hostDirToContainerDir.get(hostDir)!;
    bpfProgramArgs.push(
      '--bpf-program',
      program.programId,
      `${containerDir}/${fileName}`,
    );
  }

  const entrypoint = ['solana-test-validator'];
  const command = [
    '--rpc-port',
    String(rpcPort),
    '--bind-address',
    '0.0.0.0',
    '--ledger',
    '/tmp/solana-ledger',
    '--reset',
    '--log',
    ...bpfProgramArgs,
    ...validatorArgs,
  ];

  let builder = new GenericContainer(image)
    .withEntrypoint(entrypoint)
    .withExposedPorts(rpcPort)
    .withCommand(command)
    .withWaitStrategy(Wait.forLogMessage(/Processed Slot:/, 1))
    .withStartupTimeout(120_000);

  const effectivePlatform =
    platform ?? (isAppleSilicon() ? 'linux/amd64' : undefined);
  if (effectivePlatform) {
    builder = builder.withPlatform(effectivePlatform);
  }

  for (const [hostDir, containerDir] of hostDirToContainerDir) {
    builder = builder.withBindMounts([
      { source: hostDir, target: containerDir, mode: 'ro' },
    ]);
  }

  const container = await builder.start();

  const mappedPort = container.getMappedPort(rpcPort);
  const host = container.getHost();
  const rpcUrl = `http://${host}:${mappedPort}`;

  return {
    rpcUrl,
    mode: 'docker',
    container,
    async stop() {
      if (!keepRunning) {
        await container.stop();
      }
    },
  };
}

export async function startSolanaTestValidator(
  config: SolanaValidatorConfig = {},
): Promise<SolanaTestValidator> {
  const { forceDocker = false } = config;

  if (!forceDocker) {
    const localBinary = config.binaryPath ?? findSolanaTestValidator();
    if (localBinary) {
      // eslint-disable-next-line no-console
      console.log(`Using local solana-test-validator: ${localBinary}`);
      return startLocalValidator({ ...config, binaryPath: localBinary });
    }
  }

  if (isAppleSilicon()) {
    throw new Error(
      'No local solana-test-validator found on Apple Silicon.\n' +
        'Docker is not supported: Solana requires AVX instructions that Rosetta 2 cannot emulate.\n' +
        'Install natively from: https://docs.anza.xyz/cli/install\n' +
        'Or download directly:\n' +
        '  curl -L -o /tmp/solana.tar.bz2 https://github.com/anza-xyz/agave/releases/download/v2.0.20/solana-release-aarch64-apple-darwin.tar.bz2\n' +
        '  tar jxf /tmp/solana.tar.bz2 -C /tmp',
    );
  }

  // eslint-disable-next-line no-console
  console.log('Using Docker for solana-test-validator');
  return startDockerValidator(config);
}

export async function waitForRpcReady(
  rpcUrl: string,
  maxAttempts = 30,
  delayMs = 1000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getHealth',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.result === 'ok') {
          return;
        }
      }
    } catch {
      // Ignore errors, keep retrying
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`RPC endpoint not ready after ${maxAttempts} attempts`);
}

export const APPLE_SILICON_SKIP_MESSAGE =
  'Skipping: No local solana-test-validator found and Docker unavailable. ' +
  'Install from https://docs.anza.xyz/cli/install';
