import { expect } from 'chai';
import { describe, it } from 'mocha';
// eslint-disable-next-line import/no-nodejs-modules
import { createServer } from 'node:net';

import {
  SURFPOOL_DATASOURCE_RPC_URL_ENV,
  SolanaCluster,
  type SurfpoolNodeConfig,
  SurfpoolDatasourceMode,
  type WaitForRpcReady,
  buildSurfpoolArgs,
  buildSurfpoolDatasourceEnv,
  probeTimeoutSignal,
  redactSurfpoolStderr,
  runSurfpoolNode,
  startLocalSurfpool,
} from './surfpool-node.js';

const FORK_URL = 'https://user:secret@rpc.example/mainnet';

function baseConfig(): SurfpoolNodeConfig {
  return {
    datasource: { mode: SurfpoolDatasourceMode.Fork, rpcUrl: FORK_URL },
    rpcPort: 8899,
  };
}

describe('buildSurfpoolArgs', () => {
  it('keeps the fork datasource URL out of the argv', () => {
    const config = baseConfig();
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.not.include('--rpc-url');
    expect(args.some((arg) => arg.includes(FORK_URL))).to.equal(false);
    expect(args).to.include('--port');
    expect(args).to.include('8899');
  });

  it('passes network datasources via --network', () => {
    const config: SurfpoolNodeConfig = {
      datasource: {
        mode: SurfpoolDatasourceMode.Network,
        network: SolanaCluster.Mainnet,
      },
      rpcPort: 8899,
    };
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.include('--network');
    expect(args).to.include(SolanaCluster.Mainnet);
  });

  it('passes offline datasources via --offline', () => {
    const config: SurfpoolNodeConfig = {
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: 8899,
    };
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.include('--offline');
  });
});

describe('buildSurfpoolDatasourceEnv', () => {
  it('exposes the fork datasource URL via the datasource env var', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Fork,
      rpcUrl: FORK_URL,
    });

    expect(env).to.deep.equal({
      [SURFPOOL_DATASOURCE_RPC_URL_ENV]: FORK_URL,
    });
  });

  it('returns an empty env for network datasources', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Network,
      network: SolanaCluster.Mainnet,
    });

    expect(env).to.deep.equal({});
  });

  it('returns an empty env for offline datasources', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Offline,
    });

    expect(env).to.deep.equal({});
  });
});

describe('redactSurfpoolStderr', () => {
  it('scrubs the datasource URL and userinfo credentials while keeping context', () => {
    const detail =
      `error: failed to connect to datasource ${FORK_URL}; ` +
      'and to fallback https://alt-user:alt-pass@backup.example/rpc too';

    const redacted = redactSurfpoolStderr(detail, FORK_URL);

    // Neither the exact datasource URL nor either set of credentials survives.
    expect(redacted).to.not.include(FORK_URL);
    expect(redacted).to.not.include('secret');
    expect(redacted).to.not.include('alt-user:alt-pass');
    // The non-secret diagnostic context is retained.
    expect(redacted).to.include('failed to connect to datasource');
    expect(redacted).to.include('backup.example/rpc');
  });

  it('scrubs userinfo credentials even without a known datasource URL', () => {
    const detail = 'auth failed for https://user:p%40ss@rpc.example/mainnet';

    const redacted = redactSurfpoolStderr(detail);

    expect(redacted).to.not.include('user:p%40ss');
    expect(redacted).to.include('auth failed for');
    expect(redacted).to.include('rpc.example/mainnet');
  });
});

describe('probeTimeoutSignal parent composition', () => {
  it('aborts the probe signal when the parent aborts mid-flight', () => {
    const parent = new AbortController();
    const { signal, dispose } = probeTimeoutSignal(60_000, parent.signal);
    expect(signal.aborted).to.equal(false);

    // The in-flight probe is cancelled the instant the readiness loop is
    // aborted, rather than lingering until the per-attempt timeout.
    parent.abort();
    expect(signal.aborted).to.equal(true);
    dispose();
  });

  it('aborts immediately when the parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort();
    const { signal, dispose } = probeTimeoutSignal(60_000, parent.signal);
    expect(signal.aborted).to.equal(true);
    dispose();
  });

  it('stops tracking the parent after dispose', () => {
    const parent = new AbortController();
    const { signal, dispose } = probeTimeoutSignal(60_000, parent.signal);
    dispose();

    parent.abort();
    expect(signal.aborted).to.equal(false);
  });
});

describe('startLocalSurfpool readiness', () => {
  // A never-settling probe stands in for waitForSolanaRpcReady. It has no
  // pending timers, so once the spawn `error` wins the race the promise rejects
  // immediately and the process can exit cleanly — unlike the real probe, whose
  // ~60s of retry timers would otherwise hang the suite.
  const neverReady: WaitForRpcReady = () => new Promise<void>(() => {});

  it('rejects readiness with the real spawn error when the binary is missing', async () => {
    const config: SurfpoolNodeConfig = {
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: 8899,
    };

    const { waitForReady } = await startLocalSurfpool(
      config,
      '/nonexistent/surfpool-does-not-exist',
      neverReady,
    );

    let rejected: unknown;
    try {
      await waitForReady();
    } catch (error: unknown) {
      rejected = error;
    }

    expect(rejected).to.be.instanceOf(Error);
    if (rejected instanceof Error) {
      // The spawn ENOENT — not a misleading RPC-probe timeout — surfaces.
      expect(rejected.message).to.include('ENOENT');
    }
  });

  it('aborts the readiness probe once the spawn error wins the race', async () => {
    let capturedSignal: AbortSignal | undefined;
    const capturingNeverReady: WaitForRpcReady = (_rpcUrl, signal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {});
    };

    const config: SurfpoolNodeConfig = {
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: 8899,
    };

    const { waitForReady } = await startLocalSurfpool(
      config,
      '/nonexistent/surfpool-does-not-exist',
      capturingNeverReady,
    );

    let rejected = false;
    try {
      await waitForReady();
    } catch {
      rejected = true;
    }

    expect(rejected).to.equal(true);
    // Without the abort the never-settling probe's retry timers would keep
    // polling a dead port after the spawn error already failed the race.
    expect(capturedSignal?.aborted).to.equal(true);
  });
});

describe('runSurfpoolNode explicit binaryPath validation', () => {
  async function runError(binaryPath: string): Promise<Error> {
    const config: SurfpoolNodeConfig = {
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: 8899,
      binaryPath,
    };
    try {
      await runSurfpoolNode(config);
    } catch (error: unknown) {
      if (error instanceof Error) {
        return error;
      }
      throw error;
    }
    throw new Error('expected runSurfpoolNode to reject');
  }

  it('fails with a not-found error for a missing binary path', async () => {
    const error = await runError('/nonexistent/surfpool-does-not-exist');
    // Specific cause, not the generic "only found version(s) unknown".
    expect(error.message).to.include('surfpool binary not found at');
    expect(error.message).to.not.include('unknown');
  });

  it('fails with an unreadable-version error for a non-surfpool binary', async () => {
    // A real, runnable executable whose `--version` output is not surfpool's.
    const error = await runError(process.execPath);
    expect(error.message).to.include('could not be run');
    expect(error.message).to.not.include('only found version(s) unknown');
  });
});

describe('startLocalSurfpool port preflight', () => {
  async function occupyPort(): Promise<{
    port: number;
    close: () => Promise<void>;
  }> {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    expect(address).to.be.an('object');
    if (!address || typeof address !== 'object') {
      throw new Error('expected a bound TCP address');
    }
    return {
      port: address.port,
      close: () =>
        new Promise<void>((resolve) => blocker.close(() => resolve())),
    };
  }

  async function freeTcpPort(): Promise<number> {
    const { port, close } = await occupyPort();
    await close();
    return port;
  }

  it('rejects before spawning when the rpc port is already in use', async () => {
    const blocker = await occupyPort();

    let rejected: unknown;
    try {
      // `binaryPath` is irrelevant: the preflight throws before any spawn.
      await startLocalSurfpool(
        {
          datasource: { mode: SurfpoolDatasourceMode.Offline },
          rpcPort: blocker.port,
        },
        '/nonexistent/surfpool',
      );
    } catch (error: unknown) {
      rejected = error;
    } finally {
      await blocker.close();
    }

    expect(rejected).to.be.instanceOf(Error);
    if (rejected instanceof Error) {
      expect(rejected.message).to.include(
        `port ${blocker.port} is already in use`,
      );
    }
  });

  it('rejects before spawning when the ws port is already in use', async () => {
    // surfpool binds both --port and --ws-port; an occupied ws port must fail
    // preflight rather than spawn a doomed child that cannot bind it.
    const rpcPort = await freeTcpPort();
    const blocker = await occupyPort();

    let rejected: unknown;
    try {
      await startLocalSurfpool(
        {
          datasource: { mode: SurfpoolDatasourceMode.Offline },
          rpcPort,
          wsPort: blocker.port,
        },
        '/nonexistent/surfpool',
      );
    } catch (error: unknown) {
      rejected = error;
    } finally {
      await blocker.close();
    }

    expect(rejected).to.be.instanceOf(Error);
    if (rejected instanceof Error) {
      expect(rejected.message).to.include(
        `port ${blocker.port} is already in use`,
      );
    }
  });
});

describe('startLocalSurfpool process lifecycle', function () {
  // Real child spawns (node run with surfpool's argv exits at once on the
  // unknown arguments) take a moment, so allow generous headroom.
  this.timeout(30_000);

  async function freeTcpPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('expected a bound TCP address');
    }
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  // Never settles, so only the child's exit can settle waitForReady — isolating
  // the exit-capture path from the RPC probe.
  const neverReady: WaitForRpcReady = () => new Promise<void>(() => {});

  it('rejects promptly when the child exited before waitForReady is called', async () => {
    const rpcPort = await freeTcpPort();
    const wsPort = await freeTcpPort();
    const { waitForReady } = await startLocalSurfpool(
      { datasource: { mode: SurfpoolDatasourceMode.Offline }, rpcPort, wsPort },
      process.execPath,
      neverReady,
    );

    // Let the short-lived child exit before we wait; `exit` is not replayed, so
    // only the eager (post-spawn) capture can surface it.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const startedAt = Date.now();
    let rejected: unknown;
    try {
      await waitForReady();
    } catch (error: unknown) {
      rejected = error;
    }

    expect(rejected).to.be.instanceOf(Error);
    if (rejected instanceof Error) {
      expect(rejected.message).to.include(
        'surfpool exited before its RPC was ready',
      );
    }
    // Surfaces the exit at once rather than polling to the readiness bound.
    expect(Date.now() - startedAt).to.be.lessThan(1_000);
  });

  it('does not add a process exit listener per fork', async () => {
    const baseline = process.listenerCount('exit');
    for (let i = 0; i < 12; i++) {
      const rpcPort = await freeTcpPort();
      const wsPort = await freeTcpPort();
      const { waitForReady } = await startLocalSurfpool(
        {
          datasource: { mode: SurfpoolDatasourceMode.Offline },
          rpcPort,
          wsPort,
        },
        process.execPath,
        neverReady,
      );
      await waitForReady().catch(() => {});
    }
    // A single shared exit hook — not one per fork (which would be baseline + 12
    // and trip MaxListenersExceededWarning past ten).
    expect(process.listenerCount('exit')).to.be.at.most(baseline + 1);
  });
});
