import { expect } from 'chai';
import type { StartedTestContainer } from 'testcontainers';

import {
  formatLocalAnvilStartError,
  getAnvilRpcUrl,
  isContainerRuntimeUnavailable,
  stopLocalAnvilProcess,
} from './anvil.js';

describe('Anvil utils', () => {
  describe('isContainerRuntimeUnavailable', () => {
    it('returns true for testcontainers runtime-strategy errors', () => {
      const error = new Error(
        'Could not find a working container runtime strategy',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('returns true for docker client strategy errors', () => {
      const error = new Error('No Docker client strategy found');
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('returns false for unrelated errors', () => {
      const error = new Error('some unrelated test failure');
      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches docker daemon connection failures', () => {
      const error = new Error(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches generic docker socket connection failures', () => {
      const error = new Error(
        'Failed to connect to /var/run/docker.sock: no such file or directory',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker socket ECONNREFUSED failures', () => {
      const error = new Error(
        'connect ECONNREFUSED /var/run/docker.sock while creating container',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker socket permission-denied failures', () => {
      const error = new Error(
        'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker named-pipe connection failures', () => {
      const error = new Error(
        'error during connect: This error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/info": open //./pipe/docker_engine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors nested in error causes', () => {
      const error = new Error('container startup failed');
      (error as Error & { cause?: unknown }).cause = new Error(
        'No Docker client strategy found',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors nested in AggregateError entries', () => {
      const error = new AggregateError(
        [
          new Error('some unrelated startup issue'),
          new Error(
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
          ),
        ],
        'failed to initialize runtime',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('reads message from non-Error throw objects', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'No Docker client strategy found in custom runtime adapter',
        }),
      ).to.equal(true);
    });

    it('handles non-Error throw values safely', () => {
      expect(
        isContainerRuntimeUnavailable(
          'No Docker client strategy found while bootstrapping tests',
        ),
      ).to.equal(true);
      expect(
        isContainerRuntimeUnavailable(
          'dial unix /var/run/docker.sock: connect: permission denied',
        ),
      ).to.equal(true);
      expect(
        isContainerRuntimeUnavailable({ reason: 'random-object' }),
      ).to.equal(false);
    });
  });

  describe('getAnvilRpcUrl', () => {
    it('builds RPC url from container host and mapped port', () => {
      const container = {
        getHost: () => '127.0.0.1',
        getMappedPort: () => 18545,
      } as StartedTestContainer;

      expect(getAnvilRpcUrl(container)).to.equal('http://127.0.0.1:18545');
    });
  });

  describe('formatLocalAnvilStartError', () => {
    it('returns installation hint when anvil binary is missing', () => {
      const error = new Error('spawn anvil ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      expect(formatLocalAnvilStartError(error)).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('returns plain message for other startup errors', () => {
      const error = new Error('permission denied');
      expect(formatLocalAnvilStartError(error)).to.equal(
        'Failed to start local anvil: permission denied',
      );
    });
  });

  describe('stopLocalAnvilProcess', () => {
    const asChildProcess = (
      value: NodeJS.Process,
    ): import('child_process').ChildProcessWithoutNullStreams =>
      value as unknown as import('child_process').ChildProcessWithoutNullStreams;

    it('returns immediately when process already exited', async () => {
      let killCalled = false;
      const fakeProcess = {
        killed: false,
        exitCode: 0,
        kill: () => {
          killCalled = true;
          return true;
        },
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
      expect(killCalled).to.equal(false);
    });

    it('treats ESRCH as an already-stopped process', async () => {
      const missingProcessError = new Error(
        'kill ESRCH',
      ) as NodeJS.ErrnoException;
      missingProcessError.code = 'ESRCH';

      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => {
          throw missingProcessError;
        },
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
    });

    it('treats an unsent signal as an already-stopped process', async () => {
      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => false,
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
    });

    it('resolves when process exits after SIGTERM', async () => {
      let killSignal: NodeJS.Signals | undefined;
      let onExit: (() => void) | undefined;

      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: (signal: NodeJS.Signals) => {
          killSignal = signal;
          queueMicrotask(() => onExit?.());
          return true;
        },
        once: (event: string, handler: () => void) => {
          if (event === 'exit') onExit = handler;
          return fakeProcess;
        },
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
      expect(killSignal).to.equal('SIGTERM');
    });

    it('rejects when kill fails with non-ESRCH errors', async () => {
      const permissionError = new Error('operation not permitted');
      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => {
          throw permissionError;
        },
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      let errorMessage = '';
      try {
        await stopLocalAnvilProcess(asChildProcess(fakeProcess));
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).to.include(
        'Failed to stop local anvil process with SIGTERM',
      );
      expect(errorMessage).to.include('operation not permitted');
    });
  });
});
