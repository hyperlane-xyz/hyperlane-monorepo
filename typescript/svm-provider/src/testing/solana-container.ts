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

/**
 * Default Solana test validator Docker image.
 * Using anzaxyz/agave for Solana 2.x compatibility.
 * This image is amd64 only; on Apple Silicon it runs via Rosetta 2 emulation.
 */
export const SOLANA_VALIDATOR_IMAGE = 'anzaxyz/agave:v2.0.20';

/**
 * Default RPC port for solana-test-validator.
 */
export const SOLANA_RPC_PORT = 8899;

/**
 * Check if we're running on Apple Silicon (ARM64 Mac).
 */
export function isAppleSilicon(): boolean {
  try {
    const arch = execSync('uname -m', { encoding: 'utf-8' }).trim();
    const osName = execSync('uname -s', { encoding: 'utf-8' }).trim();
    return osName === 'Darwin' && arch === 'arm64';
  } catch {
    return false;
  }
}

/**
 * Minimum required Solana version for the tests.
 * We require 2.x for full compatibility with newer program features.
 */
const MIN_SOLANA_VERSION = { major: 2, minor: 0 };

/**
 * Parse semver-style version string.
 */
function parseVersion(
  version: string,
): { major: number; minor: number } | null {
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
}

/**
 * Check if version meets minimum requirement.
 */
function meetsMinVersion(
  version: { major: number; minor: number },
  min: { major: number; minor: number },
): boolean {
  if (version.major > min.major) return true;
  if (version.major === min.major && version.minor >= min.minor) return true;
  return false;
}

/**
 * Get version from solana-test-validator binary.
 */
function getValidatorVersion(binaryPath: string): string | null {
  try {
    const output = execSync(`"${binaryPath}" --version`, { encoding: 'utf-8' });
    const match = output.match(/solana-test-validator\s+(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Common paths to look for solana-test-validator binary.
 */
const SOLANA_BINARY_PATHS = [
  // Specific v2.x releases (check multiple versions)
  path.join(os.homedir(), '.local/share/solana/install/releases/2.0.20/bin'),
  path.join(os.homedir(), '.local/share/solana/install/releases/2.1.0/bin'),
  // User-specific installations (active release)
  path.join(os.homedir(), '.local/share/solana/install/active_release/bin'),
  // Common download location
  '/tmp/solana-release/bin',
  // Homebrew (if someone installs via brew)
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/**
 * Find the solana-test-validator binary.
 * Returns the full path if found, null otherwise.
 * Prefers v2.x versions over older versions.
 */
export function findSolanaTestValidator(): string | null {
  const candidates: Array<{ path: string; version: string }> = [];

  // Check common installation paths first (includes explicit v2.x paths)
  for (const basePath of SOLANA_BINARY_PATHS) {
    const binaryPath = path.join(basePath, 'solana-test-validator');
    if (fs.existsSync(binaryPath)) {
      const version = getValidatorVersion(binaryPath);
      if (version) {
        candidates.push({ path: binaryPath, version });
      }
    }
  }

  // Also check if it's in PATH
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

  if (candidates.length === 0) {
    return null;
  }

  // Prefer candidates that meet minimum version
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate.version);
    if (parsed && meetsMinVersion(parsed, MIN_SOLANA_VERSION)) {
      return candidate.path;
    }
  }

  // Fall back to first available (with warning)
  // eslint-disable-next-line no-console
  console.warn(
    `Warning: No Solana v${MIN_SOLANA_VERSION.major}.x found. ` +
      `Using ${candidates[0].version} which may have compatibility issues.`,
  );
  return candidates[0].path;
}

/**
 * Pre-loaded program configuration.
 */
export interface PreloadedProgram {
  /** Program ID (base58 address) */
  programId: string;
  /** Path to the .so file */
  soPath: string;
}

/**
 * Configuration for the Solana test validator.
 */
export interface SolanaValidatorConfig {
  /** Docker image to use when running in container mode */
  image?: string;
  /** Whether to keep running on exit (useful for debugging) */
  keepRunning?: boolean;
  /** Additional command arguments for solana-test-validator */
  validatorArgs?: string[];
  /** Force Docker mode even if local binary is available */
  forceDocker?: boolean;
  /** Custom path to solana-test-validator binary */
  binaryPath?: string;
  /** Custom RPC port (default: 8899) */
  rpcPort?: number;
  /** Programs to preload via --bpf-program (bypasses slow deployment) */
  preloadedPrograms?: PreloadedProgram[];
  /** Docker platform override (e.g. 'linux/amd64' for Rosetta on Apple Silicon) */
  platform?: string;
}

/**
 * Result from starting a Solana test validator.
 */
export interface SolanaTestValidator {
  /** RPC URL for connecting to the validator */
  rpcUrl: string;
  /** Mode: 'local' for native binary, 'docker' for container */
  mode: 'local' | 'docker';
  /** Stop the validator */
  stop(): Promise<void>;
  /** The Docker container (only set in docker mode) */
  container?: StartedTestContainer;
  /** The child process (only set in local mode) */
  process?: ChildProcess;
}

// For backwards compatibility
export type SolanaTestContainer = SolanaTestValidator;

/**
 * Starts a Solana test validator using local binary.
 */
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

  // Create a temporary ledger directory
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solana-ledger-'));

  // Build --bpf-program args for preloaded programs
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

  // Start the validator process
  const proc = spawn(solanaPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for validator to be ready
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for validator to start'));
    }, 120_000);

    const checkReady = (data: Buffer) => {
      output += data.toString();
      // Look for the log line that indicates the validator is ready
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
        // Give it a moment to clean up
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }
      // Clean up ledger directory
      try {
        fs.rmSync(ledgerDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Starts a Solana test validator in a Docker container.
 */
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

  // Build --bpf-program args and collect directories to mount
  const bpfProgramArgs: string[] = [];
  // Map host directories to unique container mount paths
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

  // Build args for solana-test-validator.
  // Override the entrypoint to bypass the image's solana-run.sh script,
  // which runs solana-genesis (crashes under Rosetta due to AVX requirement).
  // Use --log to write logs to stderr so testcontainers can see them.
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

  // Create the container
  let builder = new GenericContainer(image)
    .withEntrypoint(entrypoint)
    .withExposedPorts(rpcPort)
    .withCommand(command)
    .withWaitStrategy(Wait.forLogMessage(/Processed Slot:/, 1))
    .withStartupTimeout(120_000);

  // Set platform (e.g. linux/amd64 for Rosetta on Apple Silicon)
  const effectivePlatform =
    platform ?? (isAppleSilicon() ? 'linux/amd64' : undefined);
  if (effectivePlatform) {
    builder = builder.withPlatform(effectivePlatform);
  }

  // Mount host directories containing .so files
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

/**
 * Starts a Solana test validator.
 *
 * On Apple Silicon, will attempt to use a locally installed solana-test-validator
 * binary. On other platforms or if no local binary is found, uses Docker.
 *
 * @example
 * ```typescript
 * const solana = await startSolanaTestValidator();
 * console.log(`Validator started in ${solana.mode} mode at ${solana.rpcUrl}`);
 *
 * // ... run tests ...
 *
 * await solana.stop();
 * ```
 */
export async function startSolanaTestValidator(
  config: SolanaValidatorConfig = {},
): Promise<SolanaTestValidator> {
  const { forceDocker = false } = config;

  // If not forcing Docker, try local binary first
  if (!forceDocker) {
    const localBinary = config.binaryPath ?? findSolanaTestValidator();

    if (localBinary) {
      // eslint-disable-next-line no-console
      console.log(`Using local solana-test-validator: ${localBinary}`);
      return startLocalValidator({ ...config, binaryPath: localBinary });
    }
  }

  // On Apple Silicon without a local binary, Docker won't work reliably
  // because Solana binaries require AVX which Rosetta 2 doesn't emulate.
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

  // Fall back to Docker on non-ARM platforms (e.g. CI)
  // eslint-disable-next-line no-console
  console.log('Using Docker for solana-test-validator');
  return startDockerValidator(config);
}

/**
 * Waits for the RPC endpoint to be ready by polling.
 */
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

/**
 * Skip message for users without local binary or Docker.
 */
export const APPLE_SILICON_SKIP_MESSAGE =
  'Skipping: No local solana-test-validator found and Docker unavailable. ' +
  'Install from https://docs.anza.xyz/cli/install';
