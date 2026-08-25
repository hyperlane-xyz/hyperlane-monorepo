import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  validateConfig,
  parseConfig,
  loadConfigFromFile,
  substituteEnvVars,
  getDefaultDecimals,
  getDefaultSymbol,
} from '../src/config/schema';

describe('Config Schema & Validation', () => {
  it('should validate a complete and valid KeyfunderConfig', () => {
    const raw = {
      funder: {
        type: 'privateKey',
        key: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        minReserve: {
          ethereum: '0.1',
        },
      },
      chains: {
        ethereum: {
          protocol: 'ethereum',
          rpcUrl: 'http://localhost:8545',
          recipients: [
            {
              name: 'relayer-1',
              address: '0x1111111111111111111111111111111111111111',
              minBalance: '0.5',
              desiredBalance: '2.0',
              maxFundingAmount: '1.5',
            },
          ],
        },
      },
      policies: {
        standard: {
          minBalance: '0.2',
          desiredBalance: '1.0',
          maxFundingAmount: '0.8',
        },
      },
      dryRun: true,
      metricsPort: 9090,
    };

    const config = validateConfig(raw);
    expect(config.dryRun).to.be.true;
    expect(config.metricsPort).to.equal(9090);
    expect(config.chains.ethereum.protocol).to.equal('ethereum');
    expect(config.chains.ethereum.nativeDecimals).to.equal(18);
    expect(config.chains.ethereum.nativeSymbol).to.equal('ETH');
    expect(config.chains.ethereum.chain).to.equal('ethereum');
  });

  it('should assign protocol-specific default decimals and symbols', () => {
    expect(getDefaultDecimals('ethereum')).to.equal(18);
    expect(getDefaultDecimals('sealevel')).to.equal(9);
    expect(getDefaultDecimals('cosmos')).to.equal(6);

    expect(getDefaultSymbol('ethereum')).to.equal('ETH');
    expect(getDefaultSymbol('sealevel')).to.equal('SOL');
    expect(getDefaultSymbol('cosmos')).to.equal('ATOM');
  });

  it('should substitute environment variables correctly', () => {
    process.env.TEST_KEY = '0xabcd1234';
    process.env.TEST_RPC = 'https://eth.llamarpc.com';

    const input = {
      key: '${TEST_KEY}',
      rpc: '${TEST_RPC}',
      fallback: '${NON_EXISTENT_VAR:-http://default.rpc}',
    };

    const substituted = substituteEnvVars(input) as any;
    expect(substituted.key).to.equal('0xabcd1234');
    expect(substituted.rpc).to.equal('https://eth.llamarpc.com');
    expect(substituted.fallback).to.equal('http://default.rpc');
  });

  it('should reject invalid configuration with missing required fields', () => {
    const invalidConfig = {
      chains: {
        ethereum: {
          protocol: 'ethereum',
          recipients: [], // Empty recipients list should fail
        },
      },
    };

    expect(() => validateConfig(invalidConfig)).to.throw();
  });

  it('should reject unsupported protocol type', () => {
    const invalidProtocol = {
      chains: {
        bitcoin: {
          protocol: 'bitcoin_invalid',
          recipients: [{ address: '123' }],
        },
      },
    };

    expect(() => validateConfig(invalidProtocol)).to.throw();
  });

  it('should parse JSON config strings properly', () => {
    const jsonStr = JSON.stringify({
      funder: { type: 'privateKey', key: '0x123' },
      chains: {
        solana: {
          protocol: 'sealevel',
          recipients: [{ address: 'So11111111111111111111111111111111111111112' }],
        },
      },
    });

    const parsed = parseConfig(jsonStr);
    expect(parsed.chains.solana.protocol).to.equal('sealevel');
    expect(parsed.chains.solana.nativeDecimals).to.equal(9);
    expect(parsed.chains.solana.nativeSymbol).to.equal('SOL');
  });

  it('should load config from file', () => {
    const tmpPath = path.join(__dirname, 'temp_config.json');
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        funder: { type: 'privateKey', key: '0x123' },
        chains: {
          cosmos: {
            protocol: 'cosmos',
            recipients: [{ address: 'cosmos1abc' }],
          },
        },
      })
    );

    try {
      const config = loadConfigFromFile(tmpPath);
      expect(config.chains.cosmos.protocol).to.equal('cosmos');
      expect(config.chains.cosmos.nativeDecimals).to.equal(6);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  it('should throw when loading non-existent config file', () => {
    expect(() => loadConfigFromFile('/non/existent/file.json')).to.throw();
  });
});
