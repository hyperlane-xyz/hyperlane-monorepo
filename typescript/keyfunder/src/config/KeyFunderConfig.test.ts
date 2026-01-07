import { expect } from 'chai';
import fs from 'fs';
import sinon from 'sinon';

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
chains:
  ethereum:
    keys:
      - address: "0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5"
        role: "hyperlane-relayer"
        desiredBalance: "0.5"
`;
      fsExistsStub.returns(true);
      fsReadFileStub.returns(configYaml);

      const loader = KeyFunderConfigLoader.load('/path/to/config.yaml');

      expect(loader.config.version).to.equal('1');
      expect(loader.config.chains.ethereum.keys).to.have.lengthOf(1);
      expect(loader.config.chains.ethereum.keys![0].address).to.equal(
        '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
      );
    });

    it('should throw if file does not exist', () => {
      fsExistsStub.returns(false);

      expect(() => KeyFunderConfigLoader.load('/nonexistent.yaml')).to.throw(
        'Config file not found',
      );
    });

    it('should throw on invalid config', () => {
      const invalidYaml = `
version: "2"
chains: {}
`;
      fsExistsStub.returns(true);
      fsReadFileStub.returns(invalidYaml);

      expect(() => KeyFunderConfigLoader.load('/path/to/config.yaml')).to.throw(
        'Invalid keyfunder config',
      );
    });
  });

  describe('fromObject', () => {
    it('should create loader from valid object', () => {
      const config = {
        version: '1' as const,
        chains: {
          ethereum: {
            keys: [
              {
                address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
                desiredBalance: '0.5',
              },
            ],
          },
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      expect(loader.config.chains.ethereum.keys).to.have.lengthOf(1);
    });

    it('should throw on invalid object', () => {
      const config = {
        version: '2',
        chains: {},
      };

      expect(() =>
        KeyFunderConfigLoader.fromObject(
          config as unknown as { version: '1'; chains: Record<string, object> },
        ),
      ).to.throw('Invalid keyfunder config');
    });
  });

  describe('getConfiguredChains', () => {
    it('should return all chain names', () => {
      const config = {
        version: '1' as const,
        chains: {
          ethereum: { keys: [] },
          arbitrum: { keys: [] },
          polygon: { keys: [] },
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getConfiguredChains();

      expect(chains).to.have.members(['ethereum', 'arbitrum', 'polygon']);
    });
  });

  describe('getChainsToProcess', () => {
    it('should exclude skipped chains', () => {
      const config = {
        version: '1' as const,
        chains: {
          ethereum: { keys: [] },
          arbitrum: { keys: [] },
          polygon: { keys: [] },
        },
        chainsToSkip: ['polygon'],
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getChainsToProcess();

      expect(chains).to.have.members(['ethereum', 'arbitrum']);
      expect(chains).to.not.include('polygon');
    });

    it('should return all chains when none skipped', () => {
      const config = {
        version: '1' as const,
        chains: {
          ethereum: { keys: [] },
          arbitrum: { keys: [] },
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      const chains = loader.getChainsToProcess();

      expect(chains).to.have.members(['ethereum', 'arbitrum']);
    });
  });

  describe('getFunderPrivateKeyEnvVar', () => {
    it('should return configured env var name', () => {
      const config = {
        version: '1' as const,
        chains: {},
        funder: {
          privateKeyEnvVar: 'CUSTOM_PRIVATE_KEY',
        },
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      expect(loader.getFunderPrivateKeyEnvVar()).to.equal('CUSTOM_PRIVATE_KEY');
    });

    it('should return default when not configured', () => {
      const config = {
        version: '1' as const,
        chains: {},
      };

      const loader = KeyFunderConfigLoader.fromObject(config);
      expect(loader.getFunderPrivateKeyEnvVar()).to.equal('FUNDER_PRIVATE_KEY');
    });
  });
});
