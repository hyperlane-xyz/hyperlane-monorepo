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

    it('matches podman socket connection failures', () => {
      const error = new Error(
        'dial unix /run/user/1000/podman/podman.sock: connect: no such file or directory',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker socket ECONNREFUSED failures', () => {
      const error = new Error(
        'connect ECONNREFUSED /var/run/docker.sock while creating container',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches podman socket ECONNREFUSED failures', () => {
      const error = new Error(
        'connect ECONNREFUSED /run/user/1000/podman/podman.sock while creating container',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker socket ENOENT failures', () => {
      const error = new Error(
        'connect ENOENT /var/run/docker.sock while creating container',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches podman socket ENOENT failures', () => {
      const error = new Error(
        'connect ENOENT /run/user/1000/podman/podman.sock while creating container',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker socket no-such-file failures', () => {
      const error = new Error(
        'open /var/run/docker.sock: no such file or directory',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches podman socket no-such-file failures', () => {
      const error = new Error(
        'open /run/user/1000/podman/podman.sock: no such file or directory',
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

    it('matches windows docker named-pipe backslash path failures', () => {
      const error = new Error(
        'open \\\\.\\pipe\\docker_engine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.24/info": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop backslash named-pipe failures', () => {
      const error = new Error(
        'open \\\\.\\pipe\\dockerDesktopLinuxEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop npipe strategy failures', () => {
      const error = new Error(
        'Cannot connect to npipe:////./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker URL-encoded named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop URL-encoded named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop URL-encoded backslash named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%5C%5C.%5Cpipe%5CdockerDesktopLinuxEngine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop engine named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopEngine/v1.24/info": open //./pipe/dockerDesktopEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop engine URL-encoded named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopEngine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker URL-encoded backslash named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%5C%5C.%5Cpipe%5Cdocker_engine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop engine URL-encoded backslash named-pipe failures', () => {
      const error = new Error(
        'error during connect: Get "http://%5C%5C.%5Cpipe%5CdockerDesktopEngine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop engine npipe strategy failures', () => {
      const error = new Error(
        'Cannot connect to npipe:////./pipe/dockerDesktopEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches windows docker desktop engine backslash named-pipe failures', () => {
      const error = new Error(
        'open \\\\.\\pipe\\dockerDesktopEngine: The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('does not match unknown windows named-pipe engine signatures', () => {
      const error = new Error(
        'error during connect: Get "http://%2F%2F.%2Fpipe%2FrandomEngine/v1.24/info": The system cannot find the file specified.',
      );
      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
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

    it('handles cyclic cause chains safely', () => {
      const first = new Error('outer startup error');
      const second = new Error(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      );
      (first as Error & { cause?: unknown }).cause = second;
      (second as Error & { cause?: unknown }).cause = first;

      expect(isContainerRuntimeUnavailable(first)).to.equal(true);
    });

    it('reads message from non-Error throw objects', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'No Docker client strategy found in custom runtime adapter',
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors nested in object causes', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: { message: 'Cannot connect to the Docker daemon' },
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in object causes without message', () => {
      expect(
        isContainerRuntimeUnavailable({
          cause: { message: 'No Docker client strategy found' },
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors nested in object error arrays', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          errors: [
            { message: 'irrelevant startup warning' },
            { message: 'No Docker client strategy found' },
          ],
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in object error arrays without message', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: [{ message: 'Cannot connect to the Docker daemon' }],
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in iterable error collections', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: new Set([
            { message: 'random warning' },
            { message: 'No Docker client strategy found' },
          ]),
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in map-based error collections', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: new Map([
            ['first', { message: 'random warning' }],
            ['second', { message: 'Cannot connect to the Docker daemon' }],
          ]),
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in generator-based error collections', () => {
      function* generateErrors() {
        yield { message: 'random warning' };
        yield { message: 'Cannot connect to the Docker daemon' };
      }

      expect(
        isContainerRuntimeUnavailable({
          errors: generateErrors(),
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in object-valued error collections', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            first: { message: 'random warning' },
            second: { message: 'No Docker client strategy found' },
          },
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

    it('uses message field from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({ message: 'custom object failure' }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('serializes non-Error objects without message fields', () => {
      expect(
        formatLocalAnvilStartError({
          reason: 'spawn-failure',
          code: 500,
        }),
      ).to.equal(
        'Failed to start local anvil: {"reason":"spawn-failure","code":500}',
      );
    });

    it('formats circular objects without throwing', () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;

      const message = formatLocalAnvilStartError(circular);
      expect(message).to.include('Failed to start local anvil:');
      expect(message).to.include('[Circular');
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
      let killCalled = false;

      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => {
          killCalled = true;
          throw missingProcessError;
        },
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
      expect(killCalled).to.equal(true);
    });

    it('treats an unsent signal as an already-stopped process', async () => {
      let killCallCount = 0;
      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => {
          killCallCount += 1;
          return false;
        },
        once: () => fakeProcess,
        removeListener: () => fakeProcess,
      } as unknown as NodeJS.Process;

      await stopLocalAnvilProcess(asChildProcess(fakeProcess));
      expect(killCallCount).to.equal(1);
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

    it('formats non-Error kill failures with structured details', async () => {
      const fakeProcess = {
        killed: false,
        exitCode: null,
        kill: () => {
          throw { reason: 'denied', code: 13 };
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
      expect(errorMessage).to.include('"reason":"denied"');
      expect(errorMessage).to.include('"code":13');
    });
  });
});
