import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { RelayerConfig, RelayerConfigSchema } from './RelayerConfig.js';

describe('RelayerConfig', () => {
  describe('RelayerConfigSchema', () => {
    it('should validate a minimal config', () => {
      const config = { chains: ['ethereum', 'arbitrum'] };
      const result = RelayerConfigSchema.parse(config);
      expect(result.chains).to.deep.equal(['ethereum', 'arbitrum']);
    });

    it('should validate a full config', () => {
      const config = {
        chains: ['ethereum', 'arbitrum'],
        whitelist: {
          ethereum: ['0x1234567890123456789012345678901234567890'],
        },
        retryTimeout: 5000,
        cacheFile: '/tmp/cache.json',
      };
      const result = RelayerConfigSchema.parse(config);
      expect(result.chains).to.deep.equal(['ethereum', 'arbitrum']);
      expect(result.retryTimeout).to.equal(5000);
      expect(result.cacheFile).to.equal('/tmp/cache.json');
    });

    it('should reject invalid config', () => {
      const config = { chains: 'not-an-array' };
      expect(() => RelayerConfigSchema.parse(config)).to.throw();
    });
  });

  describe('RelayerConfig.load', () => {
    let tempDir: string;
    let configPath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayer-test-'));
      configPath = path.join(tempDir, 'config.yaml');
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should load a valid YAML config', () => {
      const yamlContent = `
chains:
  - ethereum
  - arbitrum
retryTimeout: 3000
`;
      fs.writeFileSync(configPath, yamlContent);

      const config = RelayerConfig.load(configPath);
      expect(config.chains).to.deep.equal(['ethereum', 'arbitrum']);
      expect(config.retryTimeout).to.equal(3000);
    });

    it('should throw on invalid YAML', () => {
      fs.writeFileSync(configPath, 'chains: [[[invalid');
      expect(() => RelayerConfig.load(configPath)).to.throw();
    });

    it('should throw on missing file', () => {
      expect(() => RelayerConfig.load('/nonexistent/path.yaml')).to.throw();
    });
  });
});
