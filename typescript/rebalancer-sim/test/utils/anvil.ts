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
 * Setup function for Mocha tests that require Anvil.
 * Automatically starts Anvil if available, skips tests if not.
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

  suite.timeout(120000);

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

    console.log('Starting Anvil...');
    try {
      state.process = await startAnvil(port);
      console.log('Anvil started\n');
    } catch (err) {
      console.log(`Failed to start Anvil: ${err}`);
      this.skip();
    }
  });

  suite.afterAll(async function () {
    if (state.process) {
      state.process.kill();
      state.process = null;
    }
  });

  return state;
}
