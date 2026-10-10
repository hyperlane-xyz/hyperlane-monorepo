import { expect } from 'chai';
import { providers, utils } from 'ethers';
import sinon from 'sinon';

import { test1, TestChainName } from '../../consts/testChains.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { TokenStandard } from '../../token/TokenStandard.js';
import { checkWarpRouteBytecode } from '../../token/warpBytecodeCheck.js';
import type { WarpCoreConfig } from '../../warp/types.js';

import {
  BytecodeValidity,
  compareBytecode,
  resolveImplementation,
  type PackageVersionRead,
} from './bytecodeComparator.js';
import {
  computeMaskedRuntimeHash,
  type BytecodeManifest,
  type BytecodeManifestSet,
  type ContractBytecodeEntry,
} from './bytecodeManifest.js';

const ROUTER = '0x1000000000000000000000000000000000000001';
const IMPL = '0x2000000000000000000000000000000000000002';
const ERC20_CODE = '0x60016002';
const MAILBOX_CODE = '0x60026003';
const PROXY_CODE = '0x60036004';
const UNKNOWN_CODE = '0x60046005';

function normalize(address: string): string {
  return utils.getAddress(address).toLowerCase();
}

function implementationSlot(address: string): string {
  return `0x${'0'.repeat(24)}${address.replace(/^0x/i, '').toLowerCase()}`;
}

function codedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function paramString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  expect(value).to.be.a('string');
  return String(value);
}

function transactionTo(params: Record<string, unknown>): string {
  const transaction = params.transaction;
  expect(transaction).to.be.an('object');
  const fields = transaction as Record<string, unknown>;
  const to = fields.to;
  expect(to).to.be.a('string');
  return String(to);
}

class FakeProvider extends providers.BaseProvider {
  private readonly storage = new Map<string, string>();
  private readonly codes = new Map<string, string>();
  private readonly versionReads = new Map<string, PackageVersionRead>();

  constructor() {
    super({ chainId: 1, name: 'test' });
  }

  override async detectNetwork(): Promise<providers.Network> {
    return { chainId: 1, name: 'test' };
  }

  override async perform(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method === 'getStorageAt') {
      return (
        this.storage.get(normalize(paramString(params, 'address'))) ??
        `0x${'0'.repeat(64)}`
      );
    }
    if (method === 'getCode') {
      return this.codes.get(normalize(paramString(params, 'address'))) ?? '0x';
    }
    if (method === 'call') {
      const read = this.versionReads.get(normalize(transactionTo(params))) ?? {
        kind: 'absent',
      };
      if (read.kind === 'version') {
        return utils.defaultAbiCoder.encode(['string'], [read.version]);
      }
      if (read.kind === 'rpc_error') {
        throw codedError('connection failed', 'SERVER_ERROR');
      }
      throw codedError('missing PACKAGE_VERSION', 'CALL_EXCEPTION');
    }
    throw new Error(`Unsupported provider method ${method}`);
  }

  setImplementation(address: string, implementationAddress?: string): void {
    this.storage.set(
      normalize(address),
      implementationAddress
        ? implementationSlot(implementationAddress)
        : `0x${'0'.repeat(64)}`,
    );
  }

  setCode(address: string, code: string): void {
    this.codes.set(normalize(address), code);
  }

  setVersionRead(address: string, read: PackageVersionRead): void {
    this.versionReads.set(normalize(address), read);
  }
}

function manifestEntry(
  packageVersion: string,
  contractName: string,
  code: string,
): ContractBytecodeEntry {
  return {
    contractName,
    sourcePath: `${contractName}.sol`,
    packageVersion,
    immutableRanges: [],
    linkRanges: [],
    maskedRuntimeHash: computeMaskedRuntimeHash(code, [], []),
  };
}

function makeManifest(
  packageVersion: string,
  contracts: Record<string, string>,
): BytecodeManifest {
  const byName: Record<string, ContractBytecodeEntry> = {};
  const byHash: Record<string, string[]> = {};
  for (const [contractName, code] of Object.entries(contracts)) {
    const entry = manifestEntry(packageVersion, contractName, code);
    byName[contractName] = entry;
    byHash[entry.maskedRuntimeHash] ||= [];
    byHash[entry.maskedRuntimeHash].push(contractName);
  }
  return { packageVersion, byName, byHash };
}

function manifestSet(): BytecodeManifestSet {
  return {
    '1.0.0': makeManifest('1.0.0', {
      HypERC20: ERC20_CODE,
      Mailbox: MAILBOX_CODE,
      TransparentUpgradeableProxy: PROXY_CODE,
    }),
  };
}

describe('bytecodeComparator', () => {
  afterEach(() => sinon.restore());

  it('resolves zero and non-zero implementation slots', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    expect(await resolveImplementation(provider, ROUTER)).to.deep.equal({
      isProxy: false,
      implementationAddress: utils.getAddress(ROUTER),
    });

    provider.setImplementation(ROUTER, IMPL);
    expect(await resolveImplementation(provider, ROUTER)).to.deep.equal({
      isProxy: true,
      implementationAddress: utils.getAddress(IMPL),
    });
  });

  it('classifies absent PACKAGE_VERSION and still cross-matches', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    provider.setCode(ROUTER, ERC20_CODE);

    const comparison = await compareBytecode(provider, ROUTER, manifestSet());
    expect(comparison.validity).to.equal(BytecodeValidity.Match);
    expect(comparison.versionSource).to.equal('absent');
    expect(comparison.matchedPackageVersion).to.equal('1.0.0');
  });

  it('matches spoofed unknown versions against covered manifests', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    provider.setCode(ROUTER, ERC20_CODE);
    provider.setVersionRead(ROUTER, { kind: 'version', version: '99.0.0' });

    const comparison = await compareBytecode(provider, ROUTER, manifestSet());
    expect(comparison.validity).to.equal(BytecodeValidity.Match);
    expect(comparison.reportedVersion).to.equal('99.0.0');
    expect(comparison.matchedPackageVersion).to.equal('1.0.0');
    expect(comparison.note).to.include('reported version 99.0.0 differs');
  });

  it('distinguishes covered and uncovered spoofed misses', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    provider.setCode(ROUTER, UNKNOWN_CODE);
    provider.setVersionRead(ROUTER, { kind: 'version', version: '1.0.0' });

    const covered = await compareBytecode(provider, ROUTER, manifestSet());
    expect(covered.validity).to.equal(BytecodeValidity.Mismatch);
    expect(covered.note).to.include('covered but no manifest hash matched');

    provider.setVersionRead(ROUTER, { kind: 'version', version: '99.0.0' });
    const uncovered = await compareBytecode(provider, ROUTER, manifestSet());
    expect(uncovered.validity).to.equal(BytecodeValidity.VersionUnavailable);
    expect(uncovered.note).to.include('reportedVersion 99.0.0 is uncovered');
  });

  it('preserves rpc_error while reading PACKAGE_VERSION', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    provider.setCode(ROUTER, ERC20_CODE);
    provider.setVersionRead(ROUTER, { kind: 'rpc_error' });

    const comparison = await compareBytecode(provider, ROUTER, manifestSet());
    expect(comparison.validity).to.equal(BytecodeValidity.Match);
    expect(comparison.versionSource).to.equal('rpc_error');
  });

  it('returns NoCode when implementation has no code', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);

    const comparison = await compareBytecode(provider, ROUTER, manifestSet());
    expect(comparison.validity).to.equal(BytecodeValidity.NoCode);
  });

  it('fails closed when proxy runtime is not canonical', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER, IMPL);
    provider.setCode(IMPL, ERC20_CODE);
    provider.setCode(ROUTER, UNKNOWN_CODE);

    const comparison = await compareBytecode(provider, ROUTER, manifestSet());
    expect(comparison.validity).to.equal(BytecodeValidity.Mismatch);
    expect(comparison.proxyValidity).to.equal(BytecodeValidity.Mismatch);
    expect(comparison.note).to.equal(
      'proxy runtime is not a canonical Hyperlane/OZ proxy',
    );
  });

  it('flags wrong contract role at a warp leg', async () => {
    const provider = new FakeProvider();
    provider.setImplementation(ROUTER);
    provider.setCode(ROUTER, MAILBOX_CODE);
    const multiProvider = new MultiProvider(
      { [TestChainName.test1]: test1 },
      { providers: { [TestChainName.test1]: provider } },
    );
    const warpConfig: WarpCoreConfig = {
      tokens: [
        {
          chainName: TestChainName.test1,
          standard: TokenStandard.EvmHypNative,
          decimals: 18,
          symbol: 'T',
          name: 'Token',
          addressOrDenom: ROUTER,
          scale: 1,
        },
      ],
    };

    const [comparison] = await checkWarpRouteBytecode(
      multiProvider,
      warpConfig,
      manifestSet(),
    );
    expect(comparison.validity).to.equal(BytecodeValidity.Mismatch);
    expect(comparison.note).to.equal(
      'matched Mailbox which is not a valid contract for EvmHypNative',
    );
  });
});
