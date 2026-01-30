import { ChildProcess, spawn } from 'child_process';
import { ethers } from 'ethers';

/**
 * Check if Anvil is available in PATH
 */
export async function isAnvilAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('which', ['anvil']);
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
}

/**
 * Check if a port is already in use (e.g., Anvil already running)
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const provider = new ethers.providers.JsonRpcProvider(
      `http://localhost:${port}`,
    );
    provider
      .getBlockNumber()
      .then(() => resolve(true))
      .catch(() => resolve(false));
  });
}

/**
 * Start Anvil process and wait for it to be ready
 */
export async function startAnvil(port: number): Promise<ChildProcess> {
  // Check if Anvil is already running on this port
  if (await isPortInUse(port)) {
    throw new Error(
      `Port ${port} already in use. Kill existing Anvil or use different port.`,
    );
  }

  return new Promise((resolve, reject) => {
    const anvil = spawn('anvil', ['--port', port.toString()], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        anvil.kill();
        reject(new Error('Anvil startup timeout'));
      }
    }, 10000);

    anvil.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      if (output.includes('Listening on')) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolve(anvil), 500);
      }
    });

    anvil.stderr?.on('data', (data: Buffer) => {
      console.error('Anvil stderr:', data.toString());
    });

    anvil.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    anvil.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Anvil exited with code ${code}`));
      }
    });
  });
}

/**
 * Stop an anvil process and wait for cleanup
 */
export async function stopAnvil(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!process || process.killed) {
      resolve();
      return;
    }

    process.on('exit', () => {
      resolve();
    });

    process.kill('SIGTERM');

    // Force kill after timeout
    setTimeout(() => {
      if (!process.killed) {
        process.kill('SIGKILL');
      }
      resolve();
    }, 2000);
  });
}

/**
 * Setup function for Mocha tests that require Anvil.
 * Starts a fresh Anvil for EACH TEST to ensure complete isolation.
 *
 * Usage:
 * ```typescript
 * describe('My Tests', function() {
 *   const anvil = setupAnvilTestSuite(this, 8545);
 *
 *   it('test case', async () => {
 *     const rpc = anvil.rpc; // http://localhost:8545
 *   });
 * });
 * ```
 */
export function setupAnvilTestSuite(
  suite: Mocha.Suite,
  port: number,
): { rpc: string; process: ChildProcess | null } {
  const state: { rpc: string; process: ChildProcess | null } = {
    rpc: `http://localhost:${port}`,
    process: null,
  };

  suite.timeout(180000); // 3 minutes per test

  // Check anvil availability once at suite start
  suite.beforeAll(async function () {
    const available = await isAnvilAvailable();
    if (!available) {
      console.log('Anvil not found in PATH. Skipping tests.');
      console.log(
        'Install with: curl -L https://foundry.paradigm.xyz | bash && foundryup',
      );
      this.skip();
      return;
    }
  });

  // Start fresh anvil before EACH test
  suite.beforeEach(async function () {
    // Kill any existing anvil on this port
    if (state.process) {
      await stopAnvil(state.process);
      state.process = null;
    }

    // Wait for port to be free
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      state.process = await startAnvil(port);
    } catch (err) {
      console.log(`Failed to start Anvil: ${err}`);
      this.skip();
    }
  });

  // Stop anvil after EACH test for clean slate
  suite.afterEach(async function () {
    if (state.process) {
      await stopAnvil(state.process);
      state.process = null;
    }
    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  return state;
}
