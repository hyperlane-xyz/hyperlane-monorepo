import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';

import { KeyFunderConfigLoader } from './KeyFunderConfig.js';
import { resolveBridgeStateFilePath } from './resolveBridgeStateFile.js';
import {
  ArbitrumOrbitBridgeMode,
  BridgeStack,
  OpStackBridgeMode,
} from './types.js';

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

      expect(loader.config.version).to.equal('1');
      expect(loader.config.roles['hyperlane-relayer'].address).to.equal(
        '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
      );
      expect(loader.config.chains.ethereum.balances).to.deep.equal({
        'hyperlane-relayer': '0.5',
      });
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
roles: {}
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
      expect(loader.config.chains.ethereum.balances).to.deep.equal({
        'hyperlane-relayer': '0.5',
      });
    });

    it('should throw on invalid object', () => {
      const config = {
        version: '2',
        roles: {},
        chains: {},
      };

      expect(() => KeyFunderConfigLoader.fromObject(config as never)).to.throw(
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

      expect(chains).to.have.members(['ethereum', 'arbitrum', 'polygon']);
    });
  });

  describe('getRequiredSignerChains', () => {
    it('includes active destinations and their bridge origins while skipping retired origins on skipped destinations', () => {
      const loader = KeyFunderConfigLoader.fromObject({
        version: '1',
        roles: {
          relayer: {
            address: '0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5',
          },
        },
        chainsToSkip: ['retiredrollup', 'ethereum'],
        chains: {
          ethereum: {
            balances: { relayer: '1' },
          },
          retiredrollup: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: BridgeStack.OpStack,
              originChain: 'retiredl1',
              mode: OpStackBridgeMode.OptimismPortal,
              bridgeContract: '0x3333333333333333333333333333333333333333',
            },
          },
          mode: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: BridgeStack.OpStack,
              originChain: 'ethereum',
              mode: OpStackBridgeMode.OptimismPortal,
              bridgeContract: '0x3333333333333333333333333333333333333333',
            },
          },
          xai: {
            balances: { relayer: '1' },
            bridge: {
              stack: BridgeStack.ArbitrumOrbit,
              originChain: 'arbitrum',
              mode: ArbitrumOrbitBridgeMode.RetryableTicket,
              inboxAddress: '0x5555555555555555555555555555555555555555',
            },
          },
        },
      });

      expect(loader.getChainsToProcess()).to.deep.equal(['mode', 'xai']);
      expect(loader.getRequiredSignerChains()).to.deep.equal([
        'mode',
        'xai',
        'ethereum',
        'arbitrum',
      ]);
    });
  });

  describe('resolveBridgeStateFilePath', () => {
    it('rejects empty KEYFUNDER_BRIDGE_STATE_FILE and accepts valid explicit paths', () => {
      sinon.restore();
      const loader = KeyFunderConfigLoader.fromObject({
        version: '1',
        roles: {},
        chains: {},
      });

      expect(() =>
        resolveBridgeStateFilePath({
          config: loader.config,
          configFile: path.join(os.tmpdir(), 'keyfunder.yaml'),
          envBridgeStateFile: '   ',
        }),
      ).to.throw(
        'KEYFUNDER_BRIDGE_STATE_FILE environment variable must not be empty when set',
      );

      expect(
        resolveBridgeStateFilePath({
          config: loader.config,
          configFile: path.join(os.tmpdir(), 'keyfunder.yaml'),
          envBridgeStateFile: '/state/bridge-state.json',
        }),
      ).to.equal('/state/bridge-state.json');
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

      expect(chains).to.have.members(['ethereum', 'arbitrum']);
      expect(chains).to.not.include('polygon');
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

      expect(chains).to.have.members(['ethereum', 'arbitrum']);
    });
  });
});
