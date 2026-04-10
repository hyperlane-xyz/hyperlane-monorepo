import { expect } from 'chai';

import { MergedRegistry, type IRegistry } from '@hyperlane-xyz/registry';

type HttpLikeError = Error & {
  response?: { status?: number };
  status?: number | string;
  statusCode?: number | string;
};

function make404Error(message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.status = '404';
  return error;
}

function makeResponse404Error(message: string): HttpLikeError {
  const error = new Error(message) as HttpLikeError;
  error.response = { status: 404 };
  return error;
}

describe('MergedRegistry', () => {
  it('returns the first successful warp route even if a later registry 404s', async () => {
    const warpRoute = { routeId: 'TEST/route', source: 'public' } as const;
    const publicRegistry = {
      getWarpRoute: async () => warpRoute,
    } as unknown as IRegistry;
    const overlayRegistry = {
      getWarpRoute: async () => {
        throw make404Error('Warp route not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getWarpRoute('TEST/route');

    expect(result).to.equal(warpRoute);
  });

  it('throws when the first registry 404s on a warp route lookup', async () => {
    const publicRegistry = {
      getWarpRoute: async () => {
        throw make404Error('Warp route not found');
      },
    } as unknown as IRegistry;
    const overlayRegistry = {
      getWarpRoute: async () => ({ routeId: 'TEST/route', source: 'overlay' }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    let caught: unknown;
    try {
      await registry.getWarpRoute('TEST/route');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('Warp route not found');
  });

  it('returns the first successful deploy config even if a later registry 404s', async () => {
    const warpDeployConfig = {
      routeId: 'TEST/route',
      source: 'public',
    } as const;
    const publicRegistry = {
      getWarpDeployConfig: async () => warpDeployConfig,
    } as unknown as IRegistry;
    const overlayRegistry = {
      getWarpDeployConfig: async () => {
        throw make404Error('Warp deploy config not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getWarpDeployConfig('TEST/route');

    expect(result).to.equal(warpDeployConfig);
  });

  it('returns metadata from earlier registries when a later registry returns a response-shaped 404', async () => {
    const publicRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'public' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getMetadata: async () => {
        throw makeResponse404Error('metadata not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getChainMetadata('ethereum');

    expect(result?.displayName).to.equal('public');
  });

  it('throws when the first registry 404s on metadata lookup', async () => {
    const publicRegistry = {
      getMetadata: async () => {
        throw make404Error('metadata not found');
      },
    } as unknown as IRegistry;
    const overlayRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'overlay' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    let caught: unknown;
    try {
      await registry.getChainMetadata('ethereum');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('metadata not found');
  });

  it('falls through to later registries when earlier ones have no route', async () => {
    const warpRoute = { routeId: 'TEST/route', source: 'overlay' } as const;
    const missingRegistry = {
      getWarpRoute: async () => null,
    } as unknown as IRegistry;
    const overlayRegistry = {
      getWarpRoute: async () => warpRoute,
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [missingRegistry, overlayRegistry],
    });

    const result = await registry.getWarpRoute('TEST/route');

    expect(result).to.equal(warpRoute);
  });

  it('uses later-registry precedence for chain metadata overlays', async () => {
    const publicRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'public' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'overlay' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getChainMetadata('ethereum');

    expect(result?.displayName).to.equal('overlay');
  });

  it('falls through to earlier chain metadata when a later overlay misses', async () => {
    const publicRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'public' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getMetadata: async () => {
        throw make404Error('metadata not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getChainMetadata('ethereum');

    expect(result?.displayName).to.equal('public');
  });

  it('uses later-registry precedence when merging full metadata maps', async () => {
    const publicRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'public' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getMetadata: async () => ({
        ethereum: { chainId: 1, displayName: 'overlay' },
        base: { chainId: 8453, displayName: 'Base' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getMetadata();

    expect(result.ethereum.displayName).to.equal('overlay');
    expect(result.base.displayName).to.equal('Base');
  });

  it('uses later-registry precedence for core address overlays', async () => {
    const publicRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0x1111', interchainGasPaymaster: '0x2222' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0xaaaa', interchainGasPaymaster: '0xbbbb' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getChainAddresses('ethereum');

    expect(result?.mailbox).to.equal('0xaaaa');
  });

  it('falls through to earlier core addresses when a later overlay misses', async () => {
    const publicRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0x1111', interchainGasPaymaster: '0x2222' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getAddresses: async () => {
        throw make404Error('addresses not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getChainAddresses('ethereum');

    expect(result?.mailbox).to.equal('0x1111');
  });

  it('throws when the first registry 404s on core address lookup', async () => {
    const publicRegistry = {
      getAddresses: async () => {
        throw make404Error('addresses not found');
      },
    } as unknown as IRegistry;
    const overlayRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0xaaaa', interchainGasPaymaster: '0xbbbb' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    let caught: unknown;
    try {
      await registry.getChainAddresses('ethereum');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('addresses not found');
  });

  it('uses later-registry precedence when merging full address maps', async () => {
    const publicRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0x1111', interchainGasPaymaster: '0x2222' },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      getAddresses: async () => ({
        ethereum: { mailbox: '0xaaaa', interchainGasPaymaster: '0xbbbb' },
        base: { mailbox: '0xcccc', interchainGasPaymaster: '0xdddd' },
      }),
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.getAddresses();

    expect(result.ethereum.mailbox).to.equal('0xaaaa');
    expect(result.base.mailbox).to.equal('0xcccc');
  });

  it('returns registry content from earlier registries when a later overlay misses', async () => {
    const publicRegistry = {
      listRegistryContent: async () => ({
        chains: {
          ethereum: {
            metadata: 'chains/ethereum/metadata.yaml',
          },
        },
        deployments: {
          warpRoutes: {
            'TEST/route': 'deployments/warp_routes/TEST/route-config.yaml',
          },
          warpDeployConfig: {},
        },
      }),
    } as unknown as IRegistry;
    const overlayRegistry = {
      listRegistryContent: async () => {
        throw make404Error('registry content not found');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, overlayRegistry],
    });

    const result = await registry.listRegistryContent();

    expect(result.chains.ethereum.metadata).to.equal(
      'chains/ethereum/metadata.yaml',
    );
    expect(result.deployments.warpRoutes['TEST/route']).to.equal(
      'deployments/warp_routes/TEST/route-config.yaml',
    );
  });

  it('still throws non-404 registry errors', async () => {
    const publicRegistry = {
      getWarpRoute: async () => ({ routeId: 'TEST/route' }),
    } as unknown as IRegistry;
    const brokenOverlayRegistry = {
      getWarpRoute: async () => {
        throw new Error('overlay unavailable');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, brokenOverlayRegistry],
    });

    let caught: unknown;
    try {
      await registry.getWarpRoute('TEST/route');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('overlay unavailable');
  });

  it('still throws non-404 deploy-config errors', async () => {
    const publicRegistry = {
      getWarpDeployConfig: async () => ({ routeId: 'TEST/route' }),
    } as unknown as IRegistry;
    const brokenOverlayRegistry = {
      getWarpDeployConfig: async () => {
        throw new Error('overlay unavailable');
      },
    } as unknown as IRegistry;

    const registry = new MergedRegistry({
      registries: [publicRegistry, brokenOverlayRegistry],
    });

    let caught: unknown;
    try {
      await registry.getWarpDeployConfig('TEST/route');
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal('overlay unavailable');
  });
});
