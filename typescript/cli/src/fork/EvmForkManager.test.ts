import { JsonRpcProvider } from '@ethersproject/providers';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createServer } from 'node:net';
import sinon from 'sinon';

import {
  type AnvilProcessHandle,
  EvmForkManager,
  type EvmForkManagerConfig,
  type WaitForEvmRpcReady,
  getAnvilCommand,
  waitForEvmRpcReady,
} from './EvmForkManager.js';

chai.use(chaiAsPromised);

describe('EvmForkManager executable selection', () => {
  const baseConfig: EvmForkManagerConfig = {
    chainName: 'arc',
    chainId: 5042,
    upstreamRpcUrl: 'https://rpc.example.org',
    port: 8545,
  };

  for (const [description, chainName, chainId, binary, gasLimitFlag] of [
    ['Arc mainnet', 'arc', 5042, 'arc-anvil', false],
    ['Arc testnet', 'arctestnet', 5042002, 'arc-anvil', false],
    ['Ethereum', 'ethereum', 1, 'anvil', true],
    ['renamed Arc metadata', 'customarc', 5042, 'arc-anvil', false],
    ['local Arc chain', 'arc', 31337, 'arc-anvil', false],
  ] as const) {
    it(`selects the correct Anvil command for ${description}`, () => {
      const command = getAnvilCommand({
        ...baseConfig,
        chainName,
        chainId,
      });
      expect(command.binary).to.equal(binary);
      expect(command.args).to.deep.equal([
        '--port',
        '8545',
        '--chain-id',
        String(chainId),
        '--fork-url',
        baseConfig.upstreamRpcUrl,
        ...(gasLimitFlag ? ['--disable-block-gas-limit'] : []),
      ]);
    });
  }
});

describe('EvmForkManager Arc mode verification', () => {
  afterEach(() => sinon.restore());

  it('rejects an Arc fork running Ethereum rules', async () => {
    const provider = new JsonRpcProvider();
    sinon.stub(provider, 'getNetwork').resolves({ name: 'arc', chainId: 5042 });
    const send = sinon.stub(provider, 'send').resolves({ network: null });

    const rejected: Error = await expect(
      waitForEvmRpcReady(provider, new AbortController().signal, 'arc', 5042),
    ).to.be.rejectedWith(Error, 'Arc Anvil did not start in Arc mode');

    expect(send.calledOnceWithExactly('anvil_nodeInfo', [])).to.equal(true);
    expect(rejected.message).to.equal('Arc Anvil did not start in Arc mode');
  });

  it('accepts Arc mode and skips the mode probe for ordinary EVM forks', async () => {
    const provider = new JsonRpcProvider();
    sinon.stub(provider, 'getNetwork').resolves({ name: 'arc', chainId: 5042 });
    const send = sinon.stub(provider, 'send').resolves({ network: 'arc' });

    await waitForEvmRpcReady(
      provider,
      new AbortController().signal,
      'arc',
      5042,
    );
    expect(send.calledOnceWithExactly('anvil_nodeInfo', [])).to.equal(true);

    send.resetHistory();
    await waitForEvmRpcReady(
      provider,
      new AbortController().signal,
      'ethereum',
      1,
    );
    expect(send.called).to.equal(false);
  });
});

async function freePort(): Promise<number> {
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

describe('EvmForkManager port preflight', () => {
  it('start() rejects before spawning when the port is already in use', async () => {
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
    const port = address.port;

    const manager = new EvmForkManager({
      chainName: 'anvil2',
      chainId: 31337,
      // Unreachable upstream: the preflight must fail before anvil is spawned,
      // so this is never dialed.
      upstreamRpcUrl: 'http://127.0.0.1:1',
      port,
    });

    try {
      await expect(manager.start()).to.be.rejectedWith(
        Error,
        `port ${port} is already in use`,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('EvmForkManager error redaction', () => {
  it('never surfaces the upstream RPC URL from anvil errors', async () => {
    // A quote in the credential is escaped when execa shell-quotes the rendered
    // command, so an exact-string strip of the raw URL would miss it and leak
    // the secret. The surfaced error must derive from none of execa's
    // rendered-command fields.
    const upstreamRpcUrl = "https://user:p'ass@host/SUPER_SECRET_KEY";
    const escapedCommand =
      "anvil --fork-url 'https://user:p'\\''ass@host/SUPER_SECRET_KEY' --disable-block-gas-limit";
    const execaLikeError = Object.assign(
      new Error(`Command failed with exit code 1: ${escapedCommand}`),
      {
        command: `anvil --fork-url ${upstreamRpcUrl} --disable-block-gas-limit`,
        escapedCommand,
        shortMessage: 'Command failed with exit code 1',
        exitCode: 1,
      },
    );
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(Promise.reject(execaLikeError), { kill: () => {} });
    const neverReady: WaitForEvmRpcReady = () => new Promise<void>(() => {});

    const manager = new EvmForkManager(
      {
        chainName: 'anvil2',
        chainId: 31337,
        upstreamRpcUrl,
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: neverReady },
    );

    const rejected: Error = await expect(manager.start()).to.be.rejectedWith(
      Error,
    );
    // Both the message and every enumerable string field must be free of the
    // URL, the secret token, and any execa-rendered command fragment.
    const enumerable = JSON.stringify(rejected);
    for (const surfaced of [rejected.message, enumerable]) {
      expect(surfaced).to.not.include(upstreamRpcUrl);
      expect(surfaced).to.not.include('SUPER_SECRET_KEY');
      expect(surfaced).to.not.include('--fork-url');
    }
  });

  it('names the missing Arc binary without exposing the upstream RPC URL', async () => {
    const upstreamRpcUrl = 'https://user:SUPER_SECRET_KEY@host/mainnet';
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(
        Promise.reject(
          Object.assign(new Error(`spawn arc-anvil ${upstreamRpcUrl}`), {
            code: 'ENOENT',
          }),
        ),
        { kill: () => {} },
      );
    const neverReady: WaitForEvmRpcReady = () => new Promise<void>(() => {});
    const manager = new EvmForkManager(
      {
        chainName: 'arc',
        chainId: 5042,
        upstreamRpcUrl,
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: neverReady },
    );

    const rejected: Error = await expect(manager.start()).to.be.rejectedWith(
      Error,
      'arc-anvil not found on PATH',
    );
    expect(JSON.stringify(rejected)).to.not.include('SUPER_SECRET_KEY');
    expect(rejected.message).to.not.include(upstreamRpcUrl);
  });
});

describe('EvmForkManager readiness error surfacing', () => {
  it('surfaces a readiness-timeout error verbatim (not the redacted anvil error)', async () => {
    // A never-exiting anvil so the exit branch never settles; only the
    // readiness rejection drives the race.
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(new Promise<void>(() => {}), { kill: () => {} });
    const timingOutReady: WaitForEvmRpcReady = () =>
      Promise.reject(new Error('anvil readiness probe timed out'));

    const manager = new EvmForkManager(
      {
        chainName: 'anvil2',
        chainId: 31337,
        upstreamRpcUrl: 'https://user:secret@host/SUPER_SECRET_KEY',
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: timingOutReady },
    );

    // The real readiness diagnostic survives rather than being flattened to
    // the generic 'anvil failed to start'.
    const rejected: Error = await expect(manager.start()).to.be.rejectedWith(
      Error,
      'anvil readiness probe timed out',
    );
    expect(rejected.message).to.equal('anvil readiness probe timed out');
  });
});

describe('EvmForkManager readiness abort', () => {
  it('aborts the readiness probe when anvil exits before its RPC is ready', async () => {
    let capturedSignal: AbortSignal | undefined;
    const capturingNeverReady: WaitForEvmRpcReady = (_provider, signal) => {
      capturedSignal = signal;
      return new Promise<void>(() => {});
    };

    // A fake anvil that "exits" immediately drives the exit branch of the race
    // without a live process; the readiness probe above never settles on its
    // own, so only the abort can stop it.
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(Promise.resolve(), { kill: () => {} });

    const manager = new EvmForkManager(
      {
        chainName: 'anvil2',
        chainId: 31337,
        upstreamRpcUrl: 'http://127.0.0.1:1',
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: capturingNeverReady },
    );

    await expect(manager.start()).to.be.rejectedWith(Error);
    // Without the abort the never-settling probe's retry timers would keep
    // polling a dead port after anvil already exited.
    expect(capturedSignal?.aborted).to.equal(true);
  });
});

describe('EvmForkManager synchronous spawn error redaction', () => {
  it('redacts the upstream RPC URL from a synchronous spawn throw', async () => {
    const upstreamRpcUrl = 'https://user:SUPER_SECRET_KEY@host/mainnet';
    // execa validates argv synchronously and can throw (e.g. an argument with a
    // NUL byte) with the raw URL in the message but no command/escapedCommand,
    // so it must be sanitized at the spawn call site rather than downstream.
    const spawnAnvil = (): AnvilProcessHandle => {
      throw new Error(
        `Arguments cannot contain null bytes: --fork-url ${upstreamRpcUrl}`,
      );
    };
    const neverReady: WaitForEvmRpcReady = () => new Promise<void>(() => {});

    const manager = new EvmForkManager(
      {
        chainName: 'anvil2',
        chainId: 31337,
        upstreamRpcUrl,
        port: await freePort(),
      },
      { spawnAnvil, waitForReady: neverReady },
    );

    const rejected: Error = await expect(manager.start()).to.be.rejectedWith(
      Error,
    );
    const enumerable = JSON.stringify(rejected);
    for (const surfaced of [rejected.message, enumerable]) {
      expect(surfaced).to.not.include(upstreamRpcUrl);
      expect(surfaced).to.not.include('SUPER_SECRET_KEY');
    }
  });
});

describe('EvmForkManager process exit listener lifecycle', () => {
  it('shares a single process exit hook across many forks', async () => {
    const baseline = process.listenerCount('exit');
    // A never-exiting anvil keeps each fork live; readiness resolves so start()
    // succeeds and the fork stays tracked.
    const spawnAnvil = (): AnvilProcessHandle =>
      Object.assign(new Promise<void>(() => {}), { kill: () => {} });
    const readyNow: WaitForEvmRpcReady = () => Promise.resolve();

    const managers: EvmForkManager[] = [];
    for (let i = 0; i < 12; i++) {
      const manager = new EvmForkManager(
        {
          chainName: `anvil${i}`,
          chainId: 31337,
          upstreamRpcUrl: 'http://127.0.0.1:1',
          port: await freePort(),
        },
        { spawnAnvil, waitForReady: readyNow },
      );
      await manager.start();
      managers.push(manager);
    }

    // Twelve live forks share one exit hook — not one listener each (baseline +
    // 12, which trips MaxListenersExceededWarning past ten).
    expect(process.listenerCount('exit')).to.be.at.most(baseline + 1);
    managers.forEach((manager) => manager.kill());
  });
});
