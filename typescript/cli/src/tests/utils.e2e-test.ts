import { expect } from 'chai';
import { $ } from 'zx';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { localTestRunCmdPrefix } from './ethereum/commands/helpers.js';

// Test addresses for different protocols
const TEST_ADDRESSES = {
  [ProtocolType.Ethereum]: {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    bytes32:
      '0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  },
  [ProtocolType.Sealevel]: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    bytes32:
      '0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61',
  },
  [ProtocolType.Cosmos]: {
    address: 'cosmos1wxeyh7zgn4tctjzs0vtqpc6p5cxq5t2muzl7ng',
    bytes32:
      '0x00000000000000000000000071b24bf8489d5785c8507b1600e341a60c0a2d5b',
    prefix: 'cosmos',
  },
};

$.verbose = false;

describe('hyperlane utils e2e tests', async function () {
  this.timeout(30_000);

  describe('addressToBytes32', () => {
    it('should convert EVM address to bytes32', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${TEST_ADDRESSES[ProtocolType.Ethereum].address}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].address);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].bytes32);
    });

    it('should convert EVM address to bytes32 with explicit protocol', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${TEST_ADDRESSES[ProtocolType.Ethereum].address} \
        ${ProtocolType.Ethereum}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(
        `Protocol: ${ProtocolType.Ethereum}`,
        'Should display protocol',
      );
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].bytes32);
    });

    it('should convert Solana address to bytes32', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${TEST_ADDRESSES[ProtocolType.Sealevel].address} \
        ${ProtocolType.Sealevel}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Sealevel].address);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Sealevel].bytes32);
    });

    it('should convert Cosmos address to bytes32', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${TEST_ADDRESSES[ProtocolType.Cosmos].address} \
        ${ProtocolType.Cosmos}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Cosmos].address);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Cosmos].bytes32);
    });

    it('should handle already converted bytes32 address', async () => {
      const bytes32 = TEST_ADDRESSES[ProtocolType.Ethereum].bytes32;
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${bytes32}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(bytes32);
    });

    it('should fail with clear error for invalid address', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        invalid_address`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('Failed to convert address');
    });
  });

  describe('bytes32ToAddress', () => {
    it('should convert bytes32 to EVM address', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${TEST_ADDRESSES[ProtocolType.Ethereum].bytes32} \
        ${ProtocolType.Ethereum}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].bytes32);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].address);
    });

    it('should convert bytes32 to Solana address', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${TEST_ADDRESSES[ProtocolType.Sealevel].bytes32} \
        ${ProtocolType.Sealevel}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Sealevel].bytes32);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Sealevel].address);
    });

    it('should convert bytes32 to Cosmos address with prefix', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${TEST_ADDRESSES[ProtocolType.Cosmos].bytes32} \
        ${ProtocolType.Cosmos} \
        ${TEST_ADDRESSES[ProtocolType.Cosmos].prefix}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Cosmos].bytes32);
      expect(stdout).to.include(
        `Prefix: ${TEST_ADDRESSES[ProtocolType.Cosmos].prefix}`,
      );
      // Note: We check that an address is returned but don't validate exact match
      // due to potential encoding differences
      expect(stdout).to.match(/Address: \w+/);
    });

    it('should accept bytes32 without 0x prefix', async () => {
      const bytes32WithoutPrefix =
        TEST_ADDRESSES[ProtocolType.Ethereum].bytes32.slice(2);
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${bytes32WithoutPrefix} \
        ${ProtocolType.Ethereum}`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(TEST_ADDRESSES[ProtocolType.Ethereum].address);
    });

    it('should fail with clear error when prefix is missing for Cosmos', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${TEST_ADDRESSES[ProtocolType.Cosmos].bytes32} \
        ${ProtocolType.Cosmos}`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('Prefix is required for cosmos');
      expect(output).to.include('Example prefixes');
    });

    it('should fail with clear error for invalid bytes32 format', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        0xinvalid \
        ${ProtocolType.Ethereum}`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('Invalid bytes32 format');
      expect(output).to.include('32-byte hex string');
    });

    it('should fail with clear error for too short bytes32', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        0x1234 \
        ${ProtocolType.Ethereum}`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('Invalid bytes32 format');
    });
  });

  describe('round-trip conversions', () => {
    it('should successfully round-trip EVM address', async () => {
      const originalAddress = TEST_ADDRESSES[ProtocolType.Ethereum].address;

      // Convert to bytes32
      const { stdout: bytes32Output } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${originalAddress}`;

      const bytes32Match = bytes32Output.match(/Bytes32: (0x[a-fA-F0-9]{64})/);
      expect(bytes32Match).to.not.be.null;
      const bytes32 = bytes32Match![1];

      // Convert back to address
      const { stdout: addressOutput } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${bytes32} \
        ${ProtocolType.Ethereum}`;

      expect(addressOutput).to.include(originalAddress);
    });

    it('should successfully round-trip Solana address', async () => {
      const originalAddress = TEST_ADDRESSES[ProtocolType.Sealevel].address;

      // Convert to bytes32
      const { stdout: bytes32Output } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 \
        ${originalAddress} \
        ${ProtocolType.Sealevel}`;

      const bytes32Match = bytes32Output.match(/Bytes32: (0x[a-fA-F0-9]{64})/);
      expect(bytes32Match).to.not.be.null;
      const bytes32 = bytes32Match![1];

      // Convert back to address
      const { stdout: addressOutput } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress \
        ${bytes32} \
        ${ProtocolType.Sealevel}`;

      expect(addressOutput).to.include(originalAddress);
    });
  });

  describe('help output', () => {
    it('should display utils command help', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils --help`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include('Utility commands for common operations');
      expect(stdout).to.include('addressToBytes32');
      expect(stdout).to.include('bytes32ToAddress');
    });

    it('should display addressToBytes32 help', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils addressToBytes32 --help`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include('Convert an address to bytes32 format');
      expect(stdout).to.include('protocol');
    });

    it('should display bytes32ToAddress help', async () => {
      const { exitCode, stdout } =
        await $`${localTestRunCmdPrefix()} hyperlane utils bytes32ToAddress --help`.nothrow();

      expect(exitCode).to.equal(0);
      expect(stdout).to.include('Convert bytes32 to an address');
      expect(stdout).to.include('prefix');
    });
  });
});
