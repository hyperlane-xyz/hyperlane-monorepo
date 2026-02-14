import { expect } from 'chai';
import type { StartedTestContainer } from 'testcontainers';

import {
  formatLocalAnvilStartError,
  getAnvilRpcUrl,
  isContainerRuntimeUnavailable,
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
});
