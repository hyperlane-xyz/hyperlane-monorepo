import { runInNewContext } from 'node:vm';

import { expect } from 'chai';
import type { StartedTestContainer } from 'testcontainers';

import {
  formatLocalAnvilStartError,
  getAnvilRpcUrl,
  isContainerRuntimeUnavailable,
  stopLocalAnvilProcess,
} from './anvil.js';

const buildUncoercibleSpoofedBoxedString = () => ({
  [Symbol.toStringTag]: 'String',
  toString() {
    throw new Error('blocked toString');
  },
  valueOf() {
    throw new Error('blocked valueOf');
  },
});

const buildCoercibleSpoofedBoxedString = (value: string) => ({
  [Symbol.toStringTag]: 'String',
  toString() {
    return value;
  },
  valueOf() {
    return value;
  },
});
const buildStringPrototypeImpostor = (value: string) => {
  const impostor = Object.create(String.prototype) as {
    toString: () => string;
    valueOf: () => string;
  };
  impostor.toString = () => value;
  impostor.valueOf = () => value;
  return impostor;
};
const buildRealBoxedStringWithThrowingToStringTag = (value: string) => {
  const boxed = new String(value);
  Object.defineProperty(boxed, Symbol.toStringTag, {
    configurable: true,
    get() {
      throw new Error('blocked toStringTag');
    },
  });
  return boxed;
};
const buildCrossRealmBoxedStringWithThrowingToStringTag = (value: string) =>
  runInNewContext(`(() => {
    const boxed = new String(${JSON.stringify(value)});
    Object.defineProperty(boxed, Symbol.toStringTag, {
      configurable: true,
      get() {
        throw new Error('blocked toStringTag');
      },
    });
    return boxed;
  })()`);

describe('Anvil utils', () => {
  describe('isContainerRuntimeUnavailable', () => {
    const buildCauseChain = (
      depth: number,
      runtimeSignalDepth: number | null,
    ): unknown => {
      const root: { message: string; cause?: unknown } = {
        message: 'root wrapper',
      };
      let cursor = root;

      for (let i = 1; i <= depth; i += 1) {
        const node: { message: string; cause?: unknown } = {
          message:
            runtimeSignalDepth === i
              ? 'No Docker client strategy found'
              : `wrapper-${i}`,
        };
        cursor.cause = node;
        cursor = node;
      }

      return root;
    };
    const noisyWrapperEntryCount = 700;

    const buildNoisyWrappersWithFallback = (
      fallbackField: 'cause' | 'errors',
      fallbackValue: unknown,
    ): ReadonlyArray<readonly [string, unknown]> => {
      const noisyMap = Object.assign(
        new Map(
          Array.from({ length: noisyWrapperEntryCount }, (_, index) => [
            index,
            { message: `noise-${index}` },
          ]),
        ),
        { [fallbackField]: fallbackValue },
      );

      const noisyArray = Object.assign(
        Array.from({ length: noisyWrapperEntryCount }, (_, index) => ({
          message: `noise-${index}`,
        })),
        { [fallbackField]: fallbackValue },
      );

      const noisySet = Object.assign(
        new Set(
          Array.from({ length: noisyWrapperEntryCount }, (_, index) => ({
            message: `noise-${index}`,
          })),
        ),
        { [fallbackField]: fallbackValue },
      );

      const noisyGenerator = {
        *[Symbol.iterator]() {
          for (let index = 0; index < noisyWrapperEntryCount; index += 1) {
            yield { message: `noise-${index}` };
          }
        },
        [fallbackField]: fallbackValue,
      };

      return [
        ['map', noisyMap],
        ['array', noisyArray],
        ['set', noisySet],
        ['generator', noisyGenerator],
      ] as const;
    };
    const buildNoisyWrappersWithMessage = (
      message: string,
    ): ReadonlyArray<readonly [string, unknown]> => {
      const noisyMap = Object.assign(
        new Map(
          Array.from({ length: noisyWrapperEntryCount }, (_, index) => [
            index,
            { message: `noise-${index}` },
          ]),
        ),
        { message },
      );

      const noisyArray = Object.assign(
        Array.from({ length: noisyWrapperEntryCount }, (_, index) => ({
          message: `noise-${index}`,
        })),
        { message },
      );

      const noisySet = Object.assign(
        new Set(
          Array.from({ length: noisyWrapperEntryCount }, (_, index) => ({
            message: `noise-${index}`,
          })),
        ),
        { message },
      );

      const noisyGenerator = {
        *[Symbol.iterator]() {
          for (let index = 0; index < noisyWrapperEntryCount; index += 1) {
            yield { message: `noise-${index}` };
          }
        },
        message,
      };

      return [
        ['map', noisyMap],
        ['array', noisyArray],
        ['set', noisySet],
        ['generator', noisyGenerator],
      ] as const;
    };

    const buildNoisyObjectWrapperWithFallback = (
      fallbackField: 'cause' | 'errors',
      fallbackValue: unknown,
    ): Record<string, unknown> => {
      const wrapper = Object.fromEntries(
        Array.from({ length: noisyWrapperEntryCount }, (_, index) => [
          `noise-${index}`,
          { message: `noise-${index}` },
        ]),
      );

      Object.defineProperty(wrapper, fallbackField, {
        value: fallbackValue,
        enumerable: false,
        configurable: true,
      });

      return wrapper;
    };
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

    it('matches docker runtime errors in string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors in boxed-string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: new String('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors in boxed-string-valued AggregateError entries when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: runInNewContext('new String("No Docker client strategy found")'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued AggregateError entries when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores non-runtime boxed-string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: new String('unrelated nested startup warning'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores non-runtime boxed-string-valued AggregateError entries when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores non-runtime cross-realm boxed-string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: runInNewContext(
          'new String("unrelated nested startup warning")',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores non-runtime cross-realm boxed-string-valued AggregateError entries when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string-valued AggregateError entries', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'errors', {
        value: buildCoercibleSpoofedBoxedString(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError entries when cause is an uncoercible spoofed boxed string', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches runtime AggregateError entries when cause is a coercible spoofed boxed string', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildCoercibleSpoofedBoxedString(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('matches runtime AggregateError entries when cause is a string-prototype impostor', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildStringPrototypeImpostor(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores uncoercible spoofed boxed-string AggregateError causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string AggregateError causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildCoercibleSpoofedBoxedString(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores string-prototype impostor AggregateError causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildStringPrototypeImpostor(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError boxed-string causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = new String('No Docker client strategy found');
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError boxed-string causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = new String('unrelated nested startup warning');
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError cross-realm boxed-string causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = runInNewContext(
        'new String("No Docker client strategy found")',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError cross-realm boxed-string causes when errors are non-runtime', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = runInNewContext(
        'new String("unrelated nested startup warning")',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError boxed-string causes when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildRealBoxedStringWithThrowingToStringTag(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError boxed-string causes when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildRealBoxedStringWithThrowingToStringTag(
        'unrelated nested startup warning',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError cross-realm boxed-string causes when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildCrossRealmBoxedStringWithThrowingToStringTag(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError cross-realm boxed-string causes when toStringTag accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = buildCrossRealmBoxedStringWithThrowingToStringTag(
        'unrelated nested startup warning',
      );
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError errors payloads when cause accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError errors payloads when cause accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError causes when errors accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = new Error('No Docker client strategy found');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError causes when errors accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      error.cause = new Error('unrelated nested startup warning');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError causes when message accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new Error('No Docker client strategy found');
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError causes when message accessor throws', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new Error('unrelated nested startup warning');
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError errors payloads when message and cause accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError errors payloads when message and cause accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: 'unrelated nested startup warning',
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime AggregateError causes when message and errors accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new Error('No Docker client strategy found');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime AggregateError causes when message and errors accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new Error('unrelated nested startup warning');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime boxed-string causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new String('No Docker client strategy found');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime boxed-string causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = new String('unrelated nested startup warning');
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = runInNewContext(
        'new String("No Docker client strategy found")',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = runInNewContext(
        'new String("unrelated nested startup warning")',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime boxed-string causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildRealBoxedStringWithThrowingToStringTag(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime boxed-string causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildRealBoxedStringWithThrowingToStringTag(
        'unrelated nested startup warning',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildCrossRealmBoxedStringWithThrowingToStringTag(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildCrossRealmBoxedStringWithThrowingToStringTag(
        'unrelated nested startup warning',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores uncoercible spoofed boxed-string causes when message and errors accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string causes when message and errors accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildCoercibleSpoofedBoxedString(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores string-prototype impostor causes when message and errors accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime') as
        | AggregateError
        | (AggregateError & { cause?: unknown });
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      error.cause = buildStringPrototypeImpostor(
        'No Docker client strategy found',
      );
      Object.defineProperty(error, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads when message and cause accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: new String('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads when message and cause accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: new String('unrelated nested startup warning'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string errors payloads when message and cause accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: runInNewContext('new String("No Docker client strategy found")'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string errors payloads when message and cause accessors throw without hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: runInNewContext(
          'new String("unrelated nested startup warning")',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads when message and cause accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads when message and cause accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string errors payloads when message and cause accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string errors payloads when message and cause accessors throw with hostile toStringTag accessors', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores uncoercible spoofed boxed-string errors payloads when message and cause accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildUncoercibleSpoofedBoxedString(),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string errors payloads when message and cause accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildCoercibleSpoofedBoxedString(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
    });

    it('ignores string-prototype impostor errors payloads when message and cause accessors throw', () => {
      const error = new AggregateError([], 'failed to initialize runtime');
      Object.defineProperty(error, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(error, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(error, 'errors', {
        value: buildStringPrototypeImpostor('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(error)).to.equal(false);
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

    it('handles Error instances with throwing message accessors in cause chains', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause = new Error(
        'No Docker client strategy found',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime causes when top-level Error message is whitespace', () => {
      const wrappedError = new Error('hidden message');
      wrappedError.message = ' ';
      (wrappedError as Error & { cause?: unknown }).cause = new Error(
        'No Docker client strategy found',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime causes when top-level Error cause is boxed string', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause = new String(
        'No Docker client strategy found',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime top-level Error boxed-string causes', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause = new String(
        'unrelated nested warning',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime causes when top-level Error boxed-string causes throw on toStringTag access', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime top-level Error boxed-string causes that throw on toStringTag access', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildRealBoxedStringWithThrowingToStringTag('unrelated nested warning');

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime causes when top-level Error cross-realm boxed-string causes', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause = runInNewContext(
        'new String("No Docker client strategy found")',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime top-level Error cross-realm boxed-string causes', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause = runInNewContext(
        'new String("unrelated nested warning")',
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime causes when top-level Error cross-realm boxed-string causes throw on toStringTag access', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime top-level Error cross-realm boxed-string causes throw on toStringTag access', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested warning',
        );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores spoofed boxed-string top-level Error causes when coercion fails', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildUncoercibleSpoofedBoxedString();

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores spoofed boxed-string top-level Error causes when coercion succeeds', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCoercibleSpoofedBoxedString('No Docker client strategy found');

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores string-prototype impostor top-level Error causes when coercion succeeds', () => {
      const wrappedError = new Error('hidden message');
      (wrappedError as Error & { cause?: unknown }).cause =
        buildStringPrototypeImpostor('No Docker client strategy found');

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string top-level Error causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause = new String(
        'No Docker client strategy found',
      );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string top-level Error causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause = new String(
        'unrelated nested startup warning',
      );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string top-level Error causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause = runInNewContext(
        'new String("No Docker client strategy found")',
      );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string top-level Error causes when message and errors accessors throw without hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause = runInNewContext(
        'new String("unrelated nested startup warning")',
      );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string top-level Error causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string top-level Error causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string top-level Error causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string top-level Error causes when message and errors accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        );
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores uncoercible spoofed boxed-string top-level Error causes when message and errors accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string top-level Error causes when message and errors accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCoercibleSpoofedBoxedString('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores string-prototype impostor top-level Error causes when message and errors accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildStringPrototypeImpostor('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime top-level Error errors payloads when cause is an uncoercible spoofed boxed string', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'No Docker client strategy found' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime top-level Error errors payloads when cause is a coercible spoofed boxed string', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCoercibleSpoofedBoxedString('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'No Docker client strategy found' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime top-level Error errors payloads when cause is a string-prototype impostor', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildStringPrototypeImpostor('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'No Docker client strategy found' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime top-level Error errors payloads when cause is an uncoercible spoofed boxed string', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildUncoercibleSpoofedBoxedString();
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'unrelated nested startup warning' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores non-runtime top-level Error errors payloads when cause is a coercible spoofed boxed string', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildCoercibleSpoofedBoxedString('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'unrelated nested startup warning' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores non-runtime top-level Error errors payloads when cause is a string-prototype impostor', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      (wrappedError as Error & { cause?: unknown }).cause =
        buildStringPrototypeImpostor('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        value: [{ message: 'unrelated nested startup warning' }],
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime errors payloads on top-level Error objects', () => {
      const wrappedError = new Error('hidden message') as Error & {
        cause?: unknown;
        errors?: unknown;
      };
      wrappedError.cause = new Error('unrelated nested warning');
      wrappedError.errors = [{ message: 'No Docker client strategy found' }];

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime errors payloads on top-level Error objects', () => {
      const wrappedError = new Error('hidden message') as Error & {
        cause?: unknown;
        errors?: unknown;
      };
      wrappedError.cause = new Error('unrelated nested warning');
      wrappedError.errors = [{ message: 'unrelated nested startup warning' }];

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime causes on top-level Error objects when errors accessor throws', () => {
      const wrappedError = new Error('hidden message') as Error & {
        cause?: unknown;
      };
      wrappedError.cause = new Error('No Docker client strategy found');
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime causes on top-level Error objects when errors accessor throws', () => {
      const wrappedError = new Error('hidden message') as Error & {
        cause?: unknown;
      };
      wrappedError.cause = new Error('unrelated nested startup warning');
      Object.defineProperty(wrappedError, 'errors', {
        get() {
          throw new Error('blocked errors getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message') as Error & {
        errors?: unknown;
      };
      wrappedError.errors = [{ message: 'No Docker client strategy found' }];
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message') as Error & {
        errors?: unknown;
      };
      wrappedError.errors = [{ message: 'unrelated nested startup warning' }];
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: new String('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: new String('unrelated nested startup warning'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: runInNewContext('new String("No Docker client strategy found")'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: runInNewContext(
          'new String("unrelated nested startup warning")',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads on top-level Error objects when cause accessor throws with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads on top-level Error objects when cause accessor throws with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores spoofed boxed-string errors payloads on top-level Error objects when cause accessor throws', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildUncoercibleSpoofedBoxedString(),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: new String('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: new String('unrelated nested startup warning'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: runInNewContext('new String("No Docker client strategy found")'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: runInNewContext(
          'new String("unrelated nested startup warning")',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime boxed-string errors payloads on top-level Error objects when message and cause accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string errors payloads on top-level Error objects when message and cause accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string errors payloads on top-level Error objects when message and cause accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string errors payloads on top-level Error objects when message and cause accessors throw with hostile toStringTag accessors', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested startup warning',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores uncoercible spoofed boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildUncoercibleSpoofedBoxedString(),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores coercible spoofed boxed-string errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildCoercibleSpoofedBoxedString(
          'No Docker client strategy found',
        ),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('ignores string-prototype impostor errors payloads on top-level Error objects when message and cause accessors throw', () => {
      const wrappedError = new Error('hidden message');
      Object.defineProperty(wrappedError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });
      Object.defineProperty(wrappedError, 'cause', {
        get() {
          throw new Error('blocked cause getter');
        },
      });
      Object.defineProperty(wrappedError, 'errors', {
        value: buildStringPrototypeImpostor('No Docker client strategy found'),
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches runtime causes when wrapper object message is whitespace', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: '   ',
          cause: { message: 'No Docker client strategy found' },
        }),
      ).to.equal(true);
    });

    it('matches runtime causes when wrapper object message accessor throws', () => {
      const wrappedError = {
        cause: { message: 'No Docker client strategy found' },
      };
      Object.defineProperty(wrappedError, 'message', {
        enumerable: true,
        get() {
          throw new Error('blocked message accessor');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors when wrapper cause accessor throws but errors are available', () => {
      const wrappedError = {
        errors: [{ message: 'No Docker client strategy found' }],
      };
      Object.defineProperty(wrappedError, 'cause', {
        enumerable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors when wrapper errors accessor throws but cause is available', () => {
      const wrappedError = {
        cause: { message: 'No Docker client strategy found' },
      };
      Object.defineProperty(wrappedError, 'errors', {
        enumerable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
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

    it('matches docker runtime errors in boxed-string-valued cause fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: new String('No Docker client strategy found'),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime boxed-string-valued cause fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: new String('unrelated nested warning'),
        }),
      ).to.equal(false);
    });

    it('matches docker runtime errors in boxed-string-valued cause fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildRealBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime boxed-string-valued cause fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildRealBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        }),
      ).to.equal(false);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued cause fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: runInNewContext(
            'new String("No Docker client strategy found")',
          ),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string-valued cause fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: runInNewContext('new String("unrelated nested warning")'),
        }),
      ).to.equal(false);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued cause fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildCrossRealmBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string-valued cause fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildCrossRealmBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        }),
      ).to.equal(false);
    });

    it('ignores spoofed boxed-string-valued cause fields when coercion fails', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildUncoercibleSpoofedBoxedString(),
        }),
      ).to.equal(false);
    });

    it('ignores spoofed boxed-string-valued cause fields when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildCoercibleSpoofedBoxedString(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(false);
    });

    it('ignores string-prototype impostor cause fields when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildStringPrototypeImpostor(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(false);
    });

    it('matches runtime errors when spoofed boxed-string cause coercion fails but errors fallback is available', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildUncoercibleSpoofedBoxedString(),
          errors: [{ message: 'No Docker client strategy found' }],
        }),
      ).to.equal(true);
    });

    it('matches runtime errors when string-prototype impostor cause is present but errors fallback is available', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'runtime bootstrap failed',
          cause: buildStringPrototypeImpostor(
            'No Docker client strategy found',
          ),
          errors: [{ message: 'No Docker client strategy found' }],
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

    it('matches docker runtime errors in error-shaped object wrappers', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: { message: 'No Docker client strategy found' },
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in error-shaped wrappers with nested causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: {
          message: 'wrapper noise',
          cause: { message: 'No Docker client strategy found' },
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches docker runtime errors in error-shaped wrappers with blank messages', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            message: '   ',
            cause: { message: 'No Docker client strategy found' },
          },
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in error-shaped wrappers with non-string messages', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            message: { detail: 'wrapper-noise' },
            cause: { message: 'No Docker client strategy found' },
          },
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in error-shaped wrappers with nested errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: {
          message: 'wrapper noise',
          errors: { message: 'Cannot connect to the Docker daemon' },
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches docker runtime errors in object error arrays without message', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: [{ message: 'Cannot connect to the Docker daemon' }],
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: 'No Docker client strategy found',
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in boxed-string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: new String('No Docker client strategy found'),
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in boxed-string-valued errors fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildRealBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: 'unrelated nested warning',
        }),
      ).to.equal(false);
    });

    it('ignores non-runtime boxed-string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: new String('unrelated nested warning'),
        }),
      ).to.equal(false);
    });

    it('ignores non-runtime boxed-string-valued errors fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildRealBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        }),
      ).to.equal(false);
    });

    it('matches runtime boxed-string throw values', () => {
      expect(
        isContainerRuntimeUnavailable(
          new String('No Docker client strategy found'),
        ),
      ).to.equal(true);
    });

    it('ignores non-runtime boxed-string throw values', () => {
      expect(
        isContainerRuntimeUnavailable(new String('unrelated nested warning')),
      ).to.equal(false);
    });

    it('matches runtime boxed-string throw values when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildRealBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        ),
      ).to.equal(true);
    });

    it('ignores non-runtime boxed-string throw values when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildRealBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        ),
      ).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string throw values', () => {
      expect(
        isContainerRuntimeUnavailable(
          runInNewContext('new String("No Docker client strategy found")'),
        ),
      ).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string throw values', () => {
      expect(
        isContainerRuntimeUnavailable(
          runInNewContext('new String("unrelated nested warning")'),
        ),
      ).to.equal(false);
    });

    it('matches runtime cross-realm boxed-string throw values when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildCrossRealmBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        ),
      ).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string throw values when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildCrossRealmBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        ),
      ).to.equal(false);
    });

    it('ignores spoofed boxed-string throw values when coercion fails', () => {
      const spoofed = buildUncoercibleSpoofedBoxedString();
      let result = false;

      expect(() => {
        result = isContainerRuntimeUnavailable(spoofed);
      }).to.not.throw();
      expect(result).to.equal(false);
    });

    it('ignores spoofed boxed-string throw values when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildCoercibleSpoofedBoxedString('No Docker client strategy found'),
        ),
      ).to.equal(false);
    });

    it('ignores string-prototype impostor throw values when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable(
          buildStringPrototypeImpostor('No Docker client strategy found'),
        ),
      ).to.equal(false);
    });

    it('matches boxed-string message fields when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: new String('No Docker client strategy found'),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string message fields when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: new String('unrelated nested warning'),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches boxed-string message fields when wrapper formatting is non-informative and toStringTag accessor throws', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: buildRealBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime boxed-string message fields when wrapper formatting is non-informative and toStringTag accessor throws', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: buildRealBoxedStringWithThrowingToStringTag(
          'unrelated nested warning',
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches cross-realm boxed-string message fields when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: runInNewContext(
          'new String("No Docker client strategy found")',
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string message fields when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: runInNewContext('new String("unrelated nested warning")'),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches cross-realm boxed-string message fields when wrapper formatting is non-informative and toStringTag accessor throws', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'No Docker client strategy found',
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string message fields when wrapper formatting is non-informative and toStringTag accessor throws', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        message: buildCrossRealmBoxedStringWithThrowingToStringTag(
          'unrelated nested warning',
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(false);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: runInNewContext(
            'new String("No Docker client strategy found")',
          ),
        }),
      ).to.equal(true);
    });

    it('matches docker runtime errors in cross-realm boxed-string-valued errors fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildCrossRealmBoxedStringWithThrowingToStringTag(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(true);
    });

    it('ignores non-runtime cross-realm boxed-string-valued errors fields', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: runInNewContext('new String("unrelated nested warning")'),
        }),
      ).to.equal(false);
    });

    it('ignores non-runtime cross-realm boxed-string-valued errors fields when toStringTag accessor throws', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildCrossRealmBoxedStringWithThrowingToStringTag(
            'unrelated nested warning',
          ),
        }),
      ).to.equal(false);
    });

    it('matches runtime causes when spoofed boxed-string errors payload coercion fails', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildUncoercibleSpoofedBoxedString(),
          cause: { message: 'No Docker client strategy found' },
        }),
      ).to.equal(true);
    });

    it('ignores spoofed boxed-string errors payloads when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildCoercibleSpoofedBoxedString(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(false);
    });

    it('matches runtime causes when coercible spoofed boxed-string errors payloads are present', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildCoercibleSpoofedBoxedString(
            'No Docker client strategy found',
          ),
          cause: { message: 'No Docker client strategy found' },
        }),
      ).to.equal(true);
    });

    it('ignores string-prototype impostor errors payloads when coercion succeeds', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildStringPrototypeImpostor(
            'No Docker client strategy found',
          ),
        }),
      ).to.equal(false);
    });

    it('matches runtime causes when string-prototype impostor errors payloads are present', () => {
      expect(
        isContainerRuntimeUnavailable({
          message: 'top-level wrapper noise',
          errors: buildStringPrototypeImpostor(
            'No Docker client strategy found',
          ),
          cause: { message: 'No Docker client strategy found' },
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

    it('matches runtime errors in iterable wrappers with cause fallbacks', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            *[Symbol.iterator]() {
              yield { message: 'non-matching wrapper noise' };
            },
            cause: { message: 'No Docker client strategy found' },
          },
        }),
      ).to.equal(true);
    });

    it('matches runtime errors in iterable wrappers with cause fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: {
          *[Symbol.iterator]() {
            yield { message: 'non-matching wrapper noise' };
          },
          cause: { message: 'No Docker client strategy found' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'iterable wrapper without nested details';
          },
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in iterable wrappers with errors fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: {
          *[Symbol.iterator]() {
            yield { message: 'non-matching wrapper noise' };
          },
          errors: { message: 'Cannot connect to the Docker daemon' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'iterable wrapper without nested details';
          },
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles iterable wrappers with self-referential errors fields and runtime causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const iterableWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'non-matching wrapper noise' };
        },
        cause: { message: 'No Docker client strategy found' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'iterable wrapper without nested details';
        },
      };
      Object.assign(iterableWrapper, { errors: iterableWrapper });

      const wrappedError = {
        errors: iterableWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
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

    it('matches runtime errors in map wrappers with cause fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: Object.assign(
          new Map([['noise', { message: 'non-matching wrapper noise' }]]),
          {
            cause: { message: 'No Docker client strategy found' },
            toJSON() {
              throw new Error('json blocked');
            },
            [inspectCustom]() {
              return 'map wrapper without nested details';
            },
          },
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in map wrappers with errors fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: Object.assign(
          new Map([['noise', { message: 'non-matching wrapper noise' }]]),
          {
            errors: { message: 'Cannot connect to the Docker daemon' },
            toJSON() {
              throw new Error('json blocked');
            },
            [inspectCustom]() {
              return 'map wrapper without nested details';
            },
          },
        ),
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles map wrappers with self-referential errors fields and runtime causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const mapWrapper = Object.assign(
        new Map([['noise', { message: 'non-matching wrapper noise' }]]),
        {
          cause: { message: 'No Docker client strategy found' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'map wrapper without nested details';
          },
        },
      );
      Object.assign(mapWrapper, { errors: mapWrapper });

      const wrappedError = {
        errors: mapWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches map wrappers when cause accessors throw but errors remain available', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const mapWrapper = Object.assign(
        new Map([['noise', { message: 'non-matching wrapper noise' }]]),
        {
          errors: { message: 'Cannot connect to the Docker daemon' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'map wrapper without nested details';
          },
        },
      );
      Object.defineProperty(mapWrapper, 'cause', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('cause blocked');
        },
      });

      const wrappedError = {
        errors: mapWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in array wrappers with cause fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const arrayWrapper = Object.assign([{ message: 'noise-entry' }], {
        cause: { message: 'No Docker client strategy found' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'array wrapper without nested details';
        },
      });
      const wrappedError = {
        errors: arrayWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in array wrappers with errors fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const arrayWrapper = Object.assign([{ message: 'noise-entry' }], {
        errors: { message: 'Cannot connect to the Docker daemon' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'array wrapper without nested details';
        },
      });
      const wrappedError = {
        errors: arrayWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles array wrappers with self-referential errors fields and runtime causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const arrayWrapper = Object.assign([{ message: 'noise-entry' }], {
        cause: { message: 'No Docker client strategy found' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'array wrapper without nested details';
        },
      });
      Object.assign(arrayWrapper, { errors: arrayWrapper });

      const wrappedError = {
        errors: arrayWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in set wrappers with cause fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(
        new Set([{ message: 'non-matching wrapper noise' }]),
        {
          cause: { message: 'No Docker client strategy found' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'set wrapper without nested details';
          },
        },
      );
      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in set wrappers with errors fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(new Set([{ message: 'noise-entry' }]), {
        errors: { message: 'Cannot connect to the Docker daemon' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'set wrapper without nested details';
        },
      });
      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches set wrappers when cause accessors throw but errors remain available', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(
        new Set([{ message: 'non-matching wrapper noise' }]),
        {
          errors: { message: 'Cannot connect to the Docker daemon' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'set wrapper without nested details';
          },
        },
      );
      Object.defineProperty(setWrapper, 'cause', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('cause blocked');
        },
      });

      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles set wrappers with self-referential errors fields and runtime causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(
        new Set([{ message: 'non-matching wrapper noise' }]),
        {
          cause: { message: 'No Docker client strategy found' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'set wrapper without nested details';
          },
        },
      );
      Object.assign(setWrapper, { errors: setWrapper });

      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
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

    it('matches runtime errors in generator wrappers with cause fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'non-matching wrapper noise' };
        },
        cause: { message: 'No Docker client strategy found' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches runtime errors in generator wrappers with errors fallbacks when wrapper formatting is non-informative', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'non-matching wrapper noise' };
        },
        errors: { message: 'Cannot connect to the Docker daemon' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles generator wrappers with self-referential errors fields and runtime causes', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'non-matching wrapper noise' };
        },
        cause: { message: 'No Docker client strategy found' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      Object.assign(generatorWrapper, { errors: generatorWrapper });

      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches generator wrappers when cause accessors throw but errors remain available', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'non-matching wrapper noise' };
        },
        errors: { message: 'Cannot connect to the Docker daemon' },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      Object.defineProperty(generatorWrapper, 'cause', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('cause blocked');
        },
      });

      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
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

    it('handles non-callable iterator markers in object error collections', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            [Symbol.iterator]: true,
            nested: { message: 'No Docker client strategy found' },
          },
        }),
      ).to.equal(true);
    });

    it('handles throwing iterators in object error collections', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            [Symbol.iterator]() {
              throw new Error('broken iterator');
            },
            nested: { message: 'No Docker client strategy found' },
          },
        }),
      ).to.equal(true);
    });

    it('handles iterable wrappers with throwing iterators and non-enumerable errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const iterableWrapper = {
        [Symbol.iterator]() {
          throw new Error('broken iterator');
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'iterable wrapper without nested details';
        },
      };
      Object.defineProperty(iterableWrapper, 'errors', {
        value: { message: 'Cannot connect to the Docker daemon' },
        enumerable: false,
      });

      const wrappedError = {
        errors: iterableWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles iterable wrappers with throwing iterators and non-enumerable message fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const iterableWrapper = {
        [Symbol.iterator]() {
          throw new Error('broken iterator');
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'iterable wrapper without nested details';
        },
      };
      Object.defineProperty(iterableWrapper, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(iterableWrapper, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(iterableWrapper, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
      });

      const wrappedError = {
        errors: iterableWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles array wrappers with throwing iterators and non-enumerable errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const arrayWrapper = Object.assign([{ message: 'noise-entry' }], {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'array wrapper without nested details';
        },
      });
      Object.defineProperty(arrayWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken array iterator');
        },
      });
      Object.defineProperty(arrayWrapper, 'errors', {
        value: { message: 'Cannot connect to the Docker daemon' },
        enumerable: false,
      });

      const wrappedError = {
        errors: arrayWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles array wrappers with throwing iterators and non-enumerable message fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const arrayWrapper = Object.assign([{ message: 'noise-entry' }], {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'array wrapper without nested details';
        },
      });
      Object.defineProperty(arrayWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken array iterator');
        },
      });
      Object.defineProperty(arrayWrapper, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(arrayWrapper, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(arrayWrapper, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
      });

      const wrappedError = {
        errors: arrayWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles set wrappers with throwing iterators and non-enumerable errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(new Set([{ message: 'noise-entry' }]), {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'set wrapper without nested details';
        },
      });
      Object.defineProperty(setWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken set iterator');
        },
      });
      Object.defineProperty(setWrapper, 'errors', {
        value: { message: 'Cannot connect to the Docker daemon' },
        enumerable: false,
      });

      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles set wrappers with throwing iterators and non-enumerable message fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const setWrapper = Object.assign(new Set([{ message: 'noise-entry' }]), {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'set wrapper without nested details';
        },
      });
      Object.defineProperty(setWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken set iterator');
        },
      });
      Object.defineProperty(setWrapper, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(setWrapper, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(setWrapper, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
      });

      const wrappedError = {
        errors: setWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles generator wrappers with throwing iterators and non-enumerable errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'noise-entry' };
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      Object.defineProperty(generatorWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken generator iterator');
        },
      });
      Object.defineProperty(generatorWrapper, 'errors', {
        value: { message: 'Cannot connect to the Docker daemon' },
        enumerable: false,
      });

      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles generator wrappers with throwing iterators and non-enumerable message fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const generatorWrapper = {
        *[Symbol.iterator]() {
          yield { message: 'noise-entry' };
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'generator wrapper without nested details';
        },
      };
      Object.defineProperty(generatorWrapper, Symbol.iterator, {
        value() {
          throw new Error('broken generator iterator');
        },
      });
      Object.defineProperty(generatorWrapper, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(generatorWrapper, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(generatorWrapper, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
      });

      const wrappedError = {
        errors: generatorWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles maps with throwing values iterators', () => {
      class ThrowingValuesMap extends Map<string, { message: string }> {
        public override values(): IterableIterator<{ message: string }> {
          let hasThrown = false;
          return {
            [Symbol.iterator]() {
              return this;
            },
            next() {
              if (!hasThrown) {
                hasThrown = true;
                throw new Error('broken map values iterator');
              }
              return { done: true, value: undefined };
            },
          } as IterableIterator<{ message: string }>;
        }
      }

      const errors = new ThrowingValuesMap();
      errors.set('runtime', { message: 'No Docker client strategy found' });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('handles map wrappers with fully throwing iterators and non-enumerable errors fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

      class ThrowingMap extends Map<string, { message: string }> {
        public override values(): IterableIterator<{ message: string }> {
          throw new Error('broken map values iterator');
        }

        public override [Symbol.iterator](): IterableIterator<
          [string, { message: string }]
        > {
          throw new Error('broken map iterator');
        }
      }

      const mapWrapper = new ThrowingMap([
        ['noise', { message: 'non-matching wrapper noise' }],
      ]);
      Object.defineProperty(mapWrapper, 'errors', {
        value: { message: 'Cannot connect to the Docker daemon' },
        enumerable: false,
      });
      Object.assign(mapWrapper, {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'map wrapper without nested details';
        },
      });

      const wrappedError = {
        errors: mapWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('handles map wrappers with fully throwing iterators and non-enumerable message fallbacks', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

      class ThrowingMap extends Map<string, { message: string }> {
        public override values(): IterableIterator<{ message: string }> {
          throw new Error('broken map values iterator');
        }

        public override [Symbol.iterator](): IterableIterator<
          [string, { message: string }]
        > {
          throw new Error('broken map iterator');
        }
      }

      const mapWrapper = new ThrowingMap([
        ['noise', { message: 'non-matching wrapper noise' }],
      ]);
      Object.defineProperty(mapWrapper, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(mapWrapper, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(mapWrapper, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
      });
      Object.assign(mapWrapper, {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'map wrapper without nested details';
        },
      });

      const wrappedError = {
        errors: mapWrapper,
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('uses map entry values (not keys) when values iterator fails', () => {
      class ThrowingValuesMap extends Map<string, { message: string }> {
        public override values(): IterableIterator<{ message: string }> {
          throw new Error('broken map values iterator');
        }
      }

      const errors = new ThrowingValuesMap();
      errors.set('No Docker client strategy found', { message: 'noise' });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(false);
    });

    it('handles unbounded iterable error collections safely', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            [Symbol.iterator]: function* infiniteErrors() {
              while (true) {
                yield { message: 'non-matching runtime warning' };
              }
            },
          },
        }),
      ).to.equal(false);
    });

    it('bounds iterable traversal and ignores late runtime signals', () => {
      expect(
        isContainerRuntimeUnavailable({
          errors: {
            [Symbol.iterator]: function* mostlyNoiseErrors() {
              for (let i = 0; i < 600; i += 1) {
                if (i === 550) {
                  yield { message: 'No Docker client strategy found' };
                  continue;
                }
                yield { message: `noise-${i}` };
              }
            },
          },
        }),
      ).to.equal(false);
    });

    it('deduplicates repeated object references to avoid extraction-starvation misses', () => {
      const sharedNoise = { message: 'noise-shared' };
      const repeatedNoiseErrors = [
        ...Array.from({ length: 700 }, () => sharedNoise),
        { message: 'No Docker client strategy found' },
      ];

      expect(
        isContainerRuntimeUnavailable({
          errors: repeatedNoiseErrors,
        }),
      ).to.equal(true);
    });

    it('deduplicates repeated primitive entries to avoid extraction-starvation misses', () => {
      const repeatedNoiseErrors = [
        ...Array.from({ length: 700 }, () => 'noise-shared'),
        'No Docker client strategy found',
      ];

      expect(
        isContainerRuntimeUnavailable({
          errors: repeatedNoiseErrors,
        }),
      ).to.equal(true);
    });

    it('matches iterable wrapper cause fallbacks even when noisy entries hit extraction limits', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const wrappedError = {
        errors: {
          *[Symbol.iterator]() {
            for (let i = 0; i < 700; i += 1) {
              yield { message: `noise-${i}` };
            }
          },
          cause: { message: 'No Docker client strategy found' },
          toJSON() {
            throw new Error('json blocked');
          },
          [inspectCustom]() {
            return 'iterable wrapper without nested details';
          },
        },
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          return 'top-level wrapper without nested details';
        },
      };

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
    });

    it('matches wrapper cause fallbacks for noisy map/array/set/generator wrappers under extraction limits', () => {
      const runtimeCause = { message: 'No Docker client strategy found' };
      for (const [wrapperName, errors] of buildNoisyWrappersWithFallback(
        'cause',
        runtimeCause,
      )) {
        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime cause`,
        ).to.equal(true);
      }
    });

    it('matches wrapper errors fallbacks for noisy map/array/set/generator wrappers under extraction limits', () => {
      const runtimeErrorsFallback = {
        message: 'Cannot connect to the Docker daemon',
      };
      for (const [wrapperName, errors] of buildNoisyWrappersWithFallback(
        'errors',
        runtimeErrorsFallback,
      )) {
        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime errors fallback`,
        ).to.equal(true);
      }
    });

    it('matches wrapper cause fallbacks for noisy wrappers with self-referential errors fields', () => {
      const runtimeCause = { message: 'No Docker client strategy found' };

      for (const [wrapperName, errors] of buildNoisyWrappersWithFallback(
        'cause',
        runtimeCause,
      )) {
        if (typeof errors === 'object' && errors !== null) {
          Object.defineProperty(errors, 'errors', {
            value: errors,
            enumerable: false,
            configurable: true,
          });
        }

        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime cause despite self-referential errors`,
        ).to.equal(true);
      }
    });

    it('matches wrapper errors fallbacks for noisy wrappers with throwing cause accessors', () => {
      const runtimeErrorsFallback = {
        message: 'Cannot connect to the Docker daemon',
      };

      for (const [wrapperName, errors] of buildNoisyWrappersWithFallback(
        'errors',
        runtimeErrorsFallback,
      )) {
        if (typeof errors === 'object' && errors !== null) {
          Object.defineProperty(errors, 'cause', {
            configurable: true,
            get() {
              throw new Error('blocked cause accessor');
            },
          });
        }

        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime errors fallback despite throwing cause`,
        ).to.equal(true);
      }
    });

    it('matches wrapper cause fallbacks for noisy wrappers with throwing errors accessors', () => {
      const runtimeCause = { message: 'No Docker client strategy found' };

      for (const [wrapperName, errors] of buildNoisyWrappersWithFallback(
        'cause',
        runtimeCause,
      )) {
        if (typeof errors === 'object' && errors !== null) {
          Object.defineProperty(errors, 'errors', {
            configurable: true,
            get() {
              throw new Error('blocked errors accessor');
            },
          });
        }

        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime cause despite throwing errors accessor`,
        ).to.equal(true);
      }
    });

    it('matches plain-object wrapper cause fallbacks under extraction limits', () => {
      const errors = buildNoisyObjectWrapperWithFallback('cause', {
        message: 'No Docker client strategy found',
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('matches plain-object wrapper errors fallbacks under extraction limits when cause accessor throws', () => {
      const errors = buildNoisyObjectWrapperWithFallback('errors', {
        message: 'Cannot connect to the Docker daemon',
      });
      Object.defineProperty(errors, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('matches plain-object wrapper cause fallbacks when errors field is self-referential', () => {
      const errors = buildNoisyObjectWrapperWithFallback('cause', {
        message: 'No Docker client strategy found',
      });
      Object.defineProperty(errors, 'errors', {
        value: errors,
        enumerable: false,
        configurable: true,
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('matches plain-object wrapper cause fallbacks when errors accessor throws', () => {
      const errors = buildNoisyObjectWrapperWithFallback('cause', {
        message: 'No Docker client strategy found',
      });
      Object.defineProperty(errors, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('matches wrapper message fallbacks for noisy map/array/set/generator wrappers under extraction limits', () => {
      for (const [wrapperName, errors] of buildNoisyWrappersWithMessage(
        'No Docker client strategy found',
      )) {
        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime message fallback`,
        ).to.equal(true);
      }
    });

    it('matches wrapper message fallbacks when cause and errors accessors throw', () => {
      for (const [wrapperName, errors] of buildNoisyWrappersWithMessage(
        'No Docker client strategy found',
      )) {
        if (typeof errors === 'object' && errors !== null) {
          Object.defineProperty(errors, 'cause', {
            configurable: true,
            get() {
              throw new Error('blocked cause accessor');
            },
          });
          Object.defineProperty(errors, 'errors', {
            configurable: true,
            get() {
              throw new Error('blocked errors accessor');
            },
          });
        }

        expect(
          isContainerRuntimeUnavailable({ errors }),
          `${wrapperName} wrapper should surface runtime message despite throwing fields`,
        ).to.equal(true);
      }
    });

    it('matches plain-object wrapper message fallback under extraction limits', () => {
      const errors = buildNoisyObjectWrapperWithFallback(
        'cause',
        'non-runtime-noise',
      );
      Object.defineProperty(errors, 'cause', {
        value: undefined,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(errors, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
        configurable: true,
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('matches plain-object wrapper message fallback when cause and errors accessors throw', () => {
      const errors = buildNoisyObjectWrapperWithFallback(
        'cause',
        'non-runtime-noise',
      );
      Object.defineProperty(errors, 'cause', {
        configurable: true,
        get() {
          throw new Error('blocked cause accessor');
        },
      });
      Object.defineProperty(errors, 'errors', {
        configurable: true,
        get() {
          throw new Error('blocked errors accessor');
        },
      });
      Object.defineProperty(errors, 'message', {
        value: 'No Docker client strategy found',
        enumerable: false,
        configurable: true,
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('still matches cause-chain runtime signals before extraction cap', () => {
      expect(isContainerRuntimeUnavailable(buildCauseChain(550, 120))).to.equal(
        true,
      );
    });

    it('ignores cause-chain runtime signals beyond extraction cap', () => {
      expect(isContainerRuntimeUnavailable(buildCauseChain(550, 520))).to.equal(
        false,
      );
    });

    it('handles object error collections with throwing property accessors', () => {
      const errors: Record<string, unknown> = {
        nested: { message: 'No Docker client strategy found' },
      };
      Object.defineProperty(errors, 'broken', {
        enumerable: true,
        get() {
          throw new Error('broken object accessor');
        },
      });

      expect(isContainerRuntimeUnavailable({ errors })).to.equal(true);
    });

    it('handles wrapper proxies with throwing message and cause accessors', () => {
      const wrappedError = new Proxy(
        {
          errors: [{ message: 'No Docker client strategy found' }],
        },
        {
          get(target, property) {
            if (property === 'message' || property === 'cause') {
              throw new Error('blocked accessor');
            }
            return Reflect.get(target, property);
          },
          has(target, property) {
            if (property === 'message') {
              throw new Error('blocked has trap');
            }
            return Reflect.has(target, property);
          },
        },
      );

      expect(isContainerRuntimeUnavailable(wrappedError)).to.equal(true);
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

    it('treats lowercase code values as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: 'enoent',
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats trimmed mixed-case code values as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: '  EnOeNt  ',
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats whitespace-heavy code values as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: '\n\tenoent\t ',
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats boxed-string code values as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: new String('  enoent  '),
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats boxed-string code values with throwing toStringTag as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: buildRealBoxedStringWithThrowingToStringTag('  EnOeNt  '),
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats cross-realm boxed-string code values as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: runInNewContext('new String("  EnOeNt  ")'),
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('treats cross-realm boxed-string code values with throwing toStringTag as ENOENT', () => {
      expect(
        formatLocalAnvilStartError({
          code: buildCrossRealmBoxedStringWithThrowingToStringTag('  EnOeNt  '),
          message: 'spawn failed',
        }),
      ).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('ignores spoofed boxed-string code values when coercion fails', () => {
      expect(
        formatLocalAnvilStartError({
          code: buildUncoercibleSpoofedBoxedString(),
          message: 'spawn failed',
        }),
      ).to.equal('Failed to start local anvil: spawn failed');
    });

    it('ignores spoofed boxed-string code values when coercion succeeds', () => {
      expect(
        formatLocalAnvilStartError({
          code: buildCoercibleSpoofedBoxedString('ENOENT'),
          message: 'spawn failed',
        }),
      ).to.equal('Failed to start local anvil: spawn failed');
    });

    it('ignores string-prototype impostor code values when coercion succeeds', () => {
      expect(
        formatLocalAnvilStartError({
          code: buildStringPrototypeImpostor('ENOENT'),
          message: 'spawn failed',
        }),
      ).to.equal('Failed to start local anvil: spawn failed');
    });

    it('returns plain message for other startup errors', () => {
      const error = new Error('permission denied');
      expect(formatLocalAnvilStartError(error)).to.equal(
        'Failed to start local anvil: permission denied',
      );
    });

    it('uses boxed-string message fields from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({
          message: new String('  custom object failure  '),
        }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('uses boxed-string message fields with throwing toStringTag from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({
          message: buildRealBoxedStringWithThrowingToStringTag(
            '  custom object failure  ',
          ),
        }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('uses cross-realm boxed-string message fields from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({
          message: runInNewContext('new String("  custom object failure  ")'),
        }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('uses cross-realm boxed-string message fields with throwing toStringTag from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({
          message: buildCrossRealmBoxedStringWithThrowingToStringTag(
            '  custom object failure  ',
          ),
        }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('falls back when spoofed boxed-string message coercion fails', () => {
      expect(
        formatLocalAnvilStartError({
          message: buildUncoercibleSpoofedBoxedString(),
          reason: 'spawn-failure',
        }),
      ).to.equal(
        'Failed to start local anvil: {"message":{},"reason":"spawn-failure"}',
      );
    });

    it('falls back when spoofed boxed-string message coercion succeeds', () => {
      expect(
        formatLocalAnvilStartError({
          message: buildCoercibleSpoofedBoxedString('custom object failure'),
          reason: 'spawn-failure',
        }),
      ).to.equal(
        'Failed to start local anvil: {"message":{},"reason":"spawn-failure"}',
      );
    });

    it('falls back when string-prototype impostor message coercion succeeds', () => {
      expect(
        formatLocalAnvilStartError({
          message: buildStringPrototypeImpostor('custom object failure'),
          reason: 'spawn-failure',
        }),
      ).to.equal(
        'Failed to start local anvil: {"message":{},"reason":"spawn-failure"}',
      );
    });

    it('uses message field from non-Error objects', () => {
      expect(
        formatLocalAnvilStartError({ message: 'custom object failure' }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('trims non-Error object messages', () => {
      expect(
        formatLocalAnvilStartError({ message: '  custom object failure  ' }),
      ).to.equal('Failed to start local anvil: custom object failure');
    });

    it('falls back when non-Error message field is empty', () => {
      expect(
        formatLocalAnvilStartError({
          message: '   ',
          reason: 'spawn-failure',
        }),
      ).to.equal(
        'Failed to start local anvil: {"message":"   ","reason":"spawn-failure"}',
      );
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

    it('falls back safely when stringify and inspect both throw', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const problematic = {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          throw new Error('inspect blocked');
        },
      };

      expect(formatLocalAnvilStartError(problematic)).to.equal(
        'Failed to start local anvil: [object Object]',
      );
    });

    it('returns stable placeholder when all formatting fallbacks throw', () => {
      const inspectCustom = Symbol.for('nodejs.util.inspect.custom');
      const unprintable = {
        toJSON() {
          throw new Error('json blocked');
        },
        [inspectCustom]() {
          throw new Error('inspect blocked');
        },
      };
      Object.defineProperty(unprintable, Symbol.toStringTag, {
        get() {
          throw new Error('tag blocked');
        },
      });

      expect(formatLocalAnvilStartError(unprintable)).to.equal(
        'Failed to start local anvil: Unprintable error value',
      );
    });

    it('ignores throwing code accessors on non-ENOENT errors', () => {
      const wrappedError = new Proxy(
        {
          message: 'runtime unavailable',
        },
        {
          get(target, property) {
            if (property === 'code') {
              throw new Error('blocked code accessor');
            }
            return Reflect.get(target, property);
          },
        },
      );

      expect(formatLocalAnvilStartError(wrappedError)).to.equal(
        'Failed to start local anvil: runtime unavailable',
      );
    });

    it('still returns ENOENT install hint when message accessor throws', () => {
      const wrappedError = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === 'code') {
              return 'ENOENT';
            }
            if (property === 'message') {
              throw new Error('blocked message accessor');
            }
            return undefined;
          },
        },
      );

      expect(formatLocalAnvilStartError(wrappedError)).to.equal(
        'Failed to start local anvil: binary not found in PATH. Install Foundry (`foundryup`) or ensure `anvil` is available.',
      );
    });

    it('handles Error instances with throwing message accessors', () => {
      const problematicError = new Error('hidden');
      Object.defineProperty(problematicError, 'message', {
        get() {
          throw new Error('blocked message getter');
        },
      });

      expect(formatLocalAnvilStartError(problematicError)).to.equal(
        'Failed to start local anvil: Error',
      );
    });

    it('falls back to Error name when message is empty', () => {
      const emptyMessageError = new Error('hidden');
      emptyMessageError.message = ' ';

      expect(formatLocalAnvilStartError(emptyMessageError)).to.equal(
        'Failed to start local anvil: Error',
      );
    });

    it('trims Error messages before formatting', () => {
      const paddedMessageError = new Error('hidden');
      paddedMessageError.message = '  permission denied  ';

      expect(formatLocalAnvilStartError(paddedMessageError)).to.equal(
        'Failed to start local anvil: permission denied',
      );
    });

    it('falls back to constructor name when Error name is empty', () => {
      const namelessError = new Error('hidden');
      namelessError.message = ' ';
      namelessError.name = ' ';

      expect(formatLocalAnvilStartError(namelessError)).to.equal(
        'Failed to start local anvil: Error',
      );
    });

    it('formats safely when message, name, and constructor access all fail', () => {
      const problematicError = new Error('hidden');
      Object.defineProperty(problematicError, 'message', {
        value: ' ',
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(problematicError, 'name', {
        value: ' ',
        configurable: true,
        enumerable: false,
      });
      Object.defineProperty(problematicError, 'constructor', {
        get() {
          throw new Error('blocked constructor getter');
        },
      });

      expect(formatLocalAnvilStartError(problematicError)).to.equal(
        'Failed to start local anvil: {}',
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
