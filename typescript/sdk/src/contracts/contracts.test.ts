import { expect } from 'chai';

import { Address } from '@hyperlane-xyz/utils';

import type { EthersLikeProvider } from '../deploy/proxy.js';

import { isAddressActive } from './contracts.js';

const ADDRESS: Address = '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba';
const CONTRACT_CODE = '0x60806040';

interface NonceProviderCalls {
  getTransactionCount: number;
}

interface ActivationProviderCalls {
  isAccountActive: number;
}

/** Provider double for chains whose liveness is inferred from the nonce. */
function nonceProvider(
  code: string,
  txnCount: number,
): { provider: EthersLikeProvider; calls: NonceProviderCalls } {
  const calls: NonceProviderCalls = { getTransactionCount: 0 };
  const double = {
    getCode: async () => code,
    getTransactionCount: async () => {
      calls.getTransactionCount += 1;
      return txnCount;
    },
  };
  // CAST: explicit test double exercising only the two methods isAddressActive calls.
  return { provider: double as unknown as EthersLikeProvider, calls };
}

/** Provider double for chains that answer activation directly (Tron). */
function activationProvider(
  code: string,
  activation: boolean | (() => Promise<boolean>),
): { provider: EthersLikeProvider; calls: ActivationProviderCalls } {
  const calls: ActivationProviderCalls = { isAccountActive: 0 };
  const double = {
    getCode: async () => code,
    getTransactionCount: async () => {
      throw new Error('getTransactionCount must not be consulted');
    },
    isAccountActive: async () => {
      calls.isAccountActive += 1;
      return typeof activation === 'boolean' ? activation : activation();
    },
  };
  // CAST: explicit test double exercising only the methods isAddressActive calls.
  return { provider: double as unknown as EthersLikeProvider, calls };
}

describe('isAddressActive', () => {
  describe('providers without an activation check', () => {
    it('returns false for an EOA with no code and a zero nonce', async () => {
      const { provider } = nonceProvider('0x', 0);

      expect(await isAddressActive(provider, ADDRESS)).to.be.false;
    });

    it('returns true for an EOA with a non-zero nonce', async () => {
      const { provider } = nonceProvider('0x', 1);

      expect(await isAddressActive(provider, ADDRESS)).to.be.true;
    });

    it('returns true for a contract regardless of nonce', async () => {
      const { provider } = nonceProvider(CONTRACT_CODE, 0);

      expect(await isAddressActive(provider, ADDRESS)).to.be.true;
    });
  });

  describe('providers with an activation check', () => {
    it('returns true for an activated EOA with no code and no nonce', async () => {
      const { provider, calls } = activationProvider('0x', true);

      expect(await isAddressActive(provider, ADDRESS)).to.be.true;
      expect(calls.isAccountActive).to.equal(1);
    });

    it('returns false for an unactivated EOA', async () => {
      const { provider, calls } = activationProvider('0x', false);

      expect(await isAddressActive(provider, ADDRESS)).to.be.false;
      expect(calls.isAccountActive).to.equal(1);
    });

    it('returns true for a contract without consulting the activation check', async () => {
      const { provider, calls } = activationProvider(CONTRACT_CODE, false);

      expect(await isAddressActive(provider, ADDRESS)).to.be.true;
      expect(calls.isAccountActive).to.equal(0);
    });

    it('returns true for a contract even when the activation check would fail', async () => {
      const { provider, calls } = activationProvider(
        CONTRACT_CODE,
        async () => {
          throw new Error('the method wallet/getaccount is not available');
        },
      );

      expect(await isAddressActive(provider, ADDRESS)).to.be.true;
      expect(calls.isAccountActive).to.equal(0);
    });

    it('propagates an activation-check failure instead of reporting inactive', async () => {
      const failure = new Error('bad response (status=503)');
      const { provider } = activationProvider('0x', async () => {
        throw failure;
      });

      let thrown: unknown;
      try {
        await isAddressActive(provider, ADDRESS);
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).to.equal(failure);
    });
  });
});
