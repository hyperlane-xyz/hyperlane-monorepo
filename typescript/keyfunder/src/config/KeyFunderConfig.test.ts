import fs from 'fs';
import sinon from 'sinon';
import { expect } from 'vitest';

import { KeyFunderConfigLoader } from './KeyFunderConfig.js';

describe('KeyFunderConfigLoader', () => {
  let fsExistsStub: sinon.SinonStub;
  let fsReadFileStub: sinon.SinonStub;

  beforeEach(() => {
    fsExistsStub = sinon.stub(fs, 'existsSync');
    fsReadFileStub = sinon.stub(fs, 'readFileSync');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('load', () => {
    it('should load valid config from file', () => {
      const configYaml = `
version: "1"
roles:
  hyperlane-relayer:
    address: "0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5"
chains:
  ethereum:
    balances:
      hyperlane-relayer: "0.5"
`;
      fsExistsStub.returns(true);
      fsReadFileStub.returns(configYaml);

      const loader = KeyFunderConfigLoader.load('/path/to/config.yaml');

      expect(loader.config.version).toBe('1');
      expect(loader.config.roles['hyperlane-relayer'].address).toBe(
        '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
      );
      expect(loader.config.chains.ethereum.balances).toEqual({
        'hyperlane-relayer': '0.5',
      });
    });

    it('should throw if file does not exist', () => {
      fsExistsStub.returns(false);

      expect(() => KeyFunderConfigLoader.load('/nonexistent.yaml')).toThrow(
        'Config file not found',
      );
    });

    it('should throw on invalid config', () => {
      const invalidYaml = `
version: "2"
roles: {}
chains: {}
`;
      fsExistsStub.returns(true);
      fsReadFileStub.returns(invalidYaml);

      expect(() => KeyFunderConfigLoader.load('/path/to/config.yaml')).toThrow(
        'Invalid keyfunder config',
      );
    });
  });

  describe('fromObject', () => {
    it('should create loader from valid object', () => {
      const config = {
        version: '1' as const,
        roles: {
          'hyperlane-relayer': {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
          },
        },
        chains: {
          ethereum: {
            balances: {
              'hyperlane-relayer': '0.5',
            },
          },
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      expect(loader.config.chains.ethereum.balances).toEqual({
        'hyperlane-relayer': '0.5',
      });
    });

    it('should throw on invalid object', () => {
      const config = {
        version: '2',
        roles: {},
        chains: {},
      };

      expect(() => KeyFunderConfigLoader.fromObject(config as never)).toThrow(
        'Invalid keyfunder config',
      );
    });
  });

  describe('getConfiguredChains', () => {
    it('should return all chain names', () => {
      const config = {
        version: '1' as const,
        roles: {},
        chains: {
          ethereum: {},
          arbitrum: {},
          polygon: {},
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getConfiguredChains();

      expect(chains).toEqual(
        expect.arrayContaining(['ethereum', 'arbitrum', 'polygon']),
      );
    });
  });

  describe('getChainsToProcess', () => {
    it('should exclude skipped chains', () => {
      const config = {
        version: '1' as const,
        roles: {},
        chains: {
          ethereum: {},
          arbitrum: {},
          polygon: {},
        },
        chainsToSkip: ['polygon'],
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getChainsToProcess();

      expect(chains).toEqual(expect.arrayContaining(['ethereum', 'arbitrum']));
      expect(chains).not.toContain('polygon');
    });

    it('should return all chains when none skipped', () => {
      const config = {
        version: '1' as const,
        roles: {},
        chains: {
          ethereum: {},
          arbitrum: {},
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getChainsToProcess();

      expect(chains).toEqual(expect.arrayContaining(['ethereum', 'arbitrum']));
    });
  });
});
