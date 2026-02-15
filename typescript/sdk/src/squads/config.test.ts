import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import {
  assertIsSquadsChain,
  getSquadsChains,
  getSquadsKeys,
  getSquadsKeysForResolvedChain,
  getUnsupportedSquadsChainsErrorMessage,
  isSquadsChain,
  partitionSquadsChains,
  resolveSquadsChainName,
  resolveSquadsChains,
  squadsConfigs,
} from './config.js';

describe('squads config', () => {
  it('exports canonical squads chain config map', () => {
    expect(squadsConfigs).to.deep.equal({
      solanamainnet: {
        programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
        multisigPda: 'EvptYJrjGUB3FXDoW8w8LTpwg1TTS4W1f628c1BnscB4',
        vault: '3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa',
      },
      soon: {
        programId: 'Hz8Zg8JYFshThnKHXSZV9XJFbyYUUKBb5NJUrxDvF8PB',
        multisigPda: '3tQm2hkauvqoRsfJg6NmUA6eMEWqFdvbiJUZUBFHXD6A',
        vault: '7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y',
      },
      eclipsemainnet: {
        programId: 'eSQDSMLf3qxwHVHeTr9amVAGmZbRLY2rFdSURandt6f',
        multisigPda: 'CSnrKeqrrLm6v9NvChYKT58mfRGYnMk8MeLGWhKvBdbk',
        vault: 'D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm',
      },
      sonicsvm: {
        programId: 'sqdsFBUUwbsuoLUhoWdw343Je6mvn7dGVVRYCa4wtqJ',
        multisigPda: 'BsdNMofu1a4ncHFJSNZWuTcZae9yt4ZGDuaneN5am5m6',
        vault: '8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y',
      },
      solaxy: {
        programId: '222DRw2LbM7xztYq1efxcbfBePi6xnv27o7QBGm9bpts',
        multisigPda: 'XgeE3uXEy5bKPbgYv3D9pWovhu3PWrxt3RR5bdp9RkW',
        vault: '4chV16Dea6CW6xyQcHj9RPwBZitfxYgpafkSoZgzy4G8',
      },
    });
  });

  it('keeps squads chain config map deeply frozen', () => {
    expect(Object.isFrozen(squadsConfigs)).to.equal(true);
    for (const chain of getSquadsChains()) {
      expect(Object.isFrozen(squadsConfigs[chain])).to.equal(true);
    }
  });

  it('keeps canonical squads config addresses parseable as Solana public keys', () => {
    for (const chain of getSquadsChains()) {
      const chainConfig = squadsConfigs[chain];
      expect(new PublicKey(chainConfig.programId).toBase58()).to.equal(
        chainConfig.programId,
      );
      expect(new PublicKey(chainConfig.multisigPda).toBase58()).to.equal(
        chainConfig.multisigPda,
      );
      expect(new PublicKey(chainConfig.vault).toBase58()).to.equal(
        chainConfig.vault,
      );
    }
  });

  it('returns canonical squads chain ordering and defensive copies', () => {
    expect(getSquadsChains()).to.deep.equal([
      'solanamainnet',
      'soon',
      'eclipsemainnet',
      'sonicsvm',
      'solaxy',
    ]);

    const first = getSquadsChains();
    const second = getSquadsChains();
    expect(first).to.not.equal(second);
    first.pop();
    expect(getSquadsChains()).to.deep.equal(second);
  });

  it('detects supported squads chains and blocks prototype pollution keys', () => {
    expect(isSquadsChain('solanamainnet')).to.equal(true);
    expect(isSquadsChain('unknown-chain')).to.equal(false);
    expect(isSquadsChain('__proto__')).to.equal(false);
    expect(isSquadsChain(1)).to.equal(false);
    expect(isSquadsChain(null)).to.equal(false);
  });

  it('asserts supported chains with helpful error context', () => {
    expect(() => assertIsSquadsChain('solanamainnet')).to.not.throw();
    expect(() => assertIsSquadsChain('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain. Available Squads chains: solanamainnet, soon, eclipsemainnet, sonicsvm, solaxy',
    );
  });

  it('rejects non-string chain names in assert and key lookups', () => {
    expect(() => assertIsSquadsChain(null)).to.throw(
      'Expected chain name to be a string, got null',
    );
    expect(() => getSquadsKeys(1)).to.throw(
      'Expected chain name to be a string, got number',
    );
  });

  it('normalizes surrounding whitespace in squads key lookups', () => {
    const trimmedLookup = getSquadsKeys('solanamainnet');
    const paddedLookup = getSquadsKeys('  solanamainnet  ');

    expect(paddedLookup.multisigPda.toBase58()).to.equal(
      trimmedLookup.multisigPda.toBase58(),
    );
    expect(paddedLookup.programId.toBase58()).to.equal(
      trimmedLookup.programId.toBase58(),
    );
    expect(paddedLookup.vault.toBase58()).to.equal(
      trimmedLookup.vault.toBase58(),
    );
  });

  it('rejects empty chain-name values in squads key lookups', () => {
    expect(() => getSquadsKeys('   ')).to.throw(
      'Expected chain name to be a non-empty string',
    );
  });

  it('resolves padded chain names to canonical squads chain values', () => {
    expect(resolveSquadsChainName('  solanamainnet  ')).to.equal(
      'solanamainnet',
    );
    expect(resolveSquadsChainName('\tsoon\n')).to.equal('soon');
  });

  it('rejects malformed resolved chain-name lookups', () => {
    expect(() => resolveSquadsChainName('   ')).to.throw(
      'Expected chain name to be a non-empty string',
    );
    expect(() => resolveSquadsChainName('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain',
    );
  });

  const malformedChainNameCases: Array<{
    value: unknown;
    expectedType: string;
  }> = [
    { value: undefined, expectedType: 'undefined' },
    { value: false, expectedType: 'boolean' },
    { value: 1n, expectedType: 'bigint' },
    { value: Symbol('chain'), expectedType: 'symbol' },
    { value: ['solanamainnet'], expectedType: 'array' },
    { value: { chain: 'solanamainnet' }, expectedType: 'object' },
    { value: () => 'solanamainnet', expectedType: 'function' },
  ];

  for (const { value, expectedType } of malformedChainNameCases) {
    it(`labels malformed chain-name type ${expectedType} in assertion errors`, () => {
      expect(() => assertIsSquadsChain(value)).to.throw(
        `Expected chain name to be a string, got ${expectedType}`,
      );
      expect(() => getSquadsKeys(value)).to.throw(
        `Expected chain name to be a string, got ${expectedType}`,
      );
      expect(() => resolveSquadsChainName(value)).to.throw(
        `Expected chain name to be a string, got ${expectedType}`,
      );
    });
  }

  it('partitions chains with dedupe and first-seen ordering', () => {
    expect(
      partitionSquadsChains([
        'unknown-b',
        ' solanamainnet ',
        'unknown-a',
        'soon',
        'unknown-b',
        'solanamainnet',
        '  unknown-a',
      ]),
    ).to.deep.equal({
      squadsChains: ['solanamainnet', 'soon'],
      nonSquadsChains: ['unknown-b', 'unknown-a'],
    });
  });

  it('rejects malformed partition inputs with index-aware types', () => {
    expect(() => partitionSquadsChains('solanamainnet')).to.throw(
      'Expected partitioned squads chains to be an array, got string',
    );

    expect(() => partitionSquadsChains(['solanamainnet', null])).to.throw(
      'Expected partitioned squads chains[1] to be a string, got null',
    );
  });

  it('throws contextual errors when partition list length accessor fails', () => {
    const hostilePartitionList = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('length unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => partitionSquadsChains(hostilePartitionList)).to.throw(
      'Failed to read partitioned squads chains length: length unavailable',
    );
  });

  it('throws contextual errors when partition list index access fails', () => {
    const hostilePartitionList = new Proxy(['solanamainnet'], {
      get(target, property, receiver) {
        if (property === '0') {
          throw new Error('entry unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => partitionSquadsChains(hostilePartitionList)).to.throw(
      'Failed to read partitioned squads chains[0]: entry unavailable',
    );
  });

  it('rejects malformed partition list lengths', () => {
    const hostilePartitionList = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          return 1n;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => partitionSquadsChains(hostilePartitionList)).to.throw(
      'Malformed partitioned squads chains length: expected non-negative safe integer, got bigint',
    );
  });

  it('formats unsupported chain errors with normalized deduped values', () => {
    expect(
      getUnsupportedSquadsChainsErrorMessage(
        ['  ethereum  ', '', 'ethereum', '  ', 'soon'],
        ['', ' solanamainnet ', 'solanamainnet', ''],
      ),
    ).to.equal(
      'Squads configuration not found for chains: ethereum, <empty>, soon. Available Squads chains: <empty>, solanamainnet',
    );
  });

  it('rejects malformed formatter inputs', () => {
    expect(() => getUnsupportedSquadsChainsErrorMessage('ethereum')).to.throw(
      'Expected unsupported squads chains to be an array, got string',
    );
    expect(() => getUnsupportedSquadsChainsErrorMessage(null)).to.throw(
      'Expected unsupported squads chains to be an array, got null',
    );

    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum'], []),
    ).to.throw('Expected at least one configured squads chain');

    expect(() => getUnsupportedSquadsChainsErrorMessage([])).to.throw(
      'Expected at least one unsupported squads chain to format error message',
    );
  });

  it('throws contextual formatter errors when unsupported-chain list length getter fails', () => {
    const hostileUnsupportedChains = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new Error('length unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(hostileUnsupportedChains),
    ).to.throw(
      'Failed to read unsupported squads chains length: length unavailable',
    );
  });

  it('uses deterministic placeholder when unsupported-chain length getter throws opaque object', () => {
    const hostileUnsupportedChains = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw {};
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(hostileUnsupportedChains),
    ).to.throw(
      'Failed to read unsupported squads chains length: [unstringifiable error]',
    );
  });

  it('resolves explicit chains and defaults while validating runtime input', () => {
    expect(resolveSquadsChains()).to.deep.equal(getSquadsChains());
    expect(resolveSquadsChains([])).to.deep.equal(getSquadsChains());
    expect(
      resolveSquadsChains([' solanamainnet ', 'solanamainnet']),
    ).to.deep.equal(['solanamainnet']);

    expect(() => resolveSquadsChains('solanamainnet')).to.throw(
      'Expected squads chains to be an array, got string',
    );
    expect(() => resolveSquadsChains(null)).to.throw(
      'Expected squads chains to be an array, got null',
    );
    expect(() => resolveSquadsChains(['solanamainnet', 1])).to.throw(
      'Expected squads chains[1] to be a string, got number',
    );
  });

  it('throws contextual resolve errors when squads-chain list index access fails', () => {
    const hostileResolveChains = new Proxy(['solanamainnet'], {
      get(target, property, receiver) {
        if (property === '0') {
          throw new Error('entry unavailable');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => resolveSquadsChains(hostileResolveChains)).to.throw(
      'Failed to read squads chains[0]: entry unavailable',
    );
  });

  it('returns frozen squads key containers with canonical addresses', () => {
    const keys = getSquadsKeys('solanamainnet');
    expect(Object.isFrozen(keys)).to.equal(true);
    expect(keys.multisigPda).to.be.instanceOf(PublicKey);
    expect(keys.programId).to.be.instanceOf(PublicKey);
    expect(keys.vault).to.be.instanceOf(PublicKey);
    expect(keys.multisigPda.toBase58()).to.equal(
      squadsConfigs.solanamainnet.multisigPda,
    );
    expect(keys.programId.toBase58()).to.equal(
      squadsConfigs.solanamainnet.programId,
    );
    expect(keys.vault.toBase58()).to.equal(squadsConfigs.solanamainnet.vault);
  });

  it('returns frozen squads key containers for resolved chain names', () => {
    const keys = getSquadsKeysForResolvedChain('solanamainnet');
    expect(Object.isFrozen(keys)).to.equal(true);
    expect(keys.multisigPda.toBase58()).to.equal(
      squadsConfigs.solanamainnet.multisigPda,
    );
    expect(keys.programId.toBase58()).to.equal(
      squadsConfigs.solanamainnet.programId,
    );
    expect(keys.vault.toBase58()).to.equal(squadsConfigs.solanamainnet.vault);
  });

  it('returns fresh immutable squads key containers per lookup', () => {
    const firstKeys = getSquadsKeys('solanamainnet');
    const secondKeys = getSquadsKeys('solanamainnet');

    expect(firstKeys).to.not.equal(secondKeys);
    expect(Object.isFrozen(firstKeys)).to.equal(true);
    expect(Object.isFrozen(secondKeys)).to.equal(true);
    expect(firstKeys.multisigPda.toBase58()).to.equal(
      secondKeys.multisigPda.toBase58(),
    );
    expect(firstKeys.programId.toBase58()).to.equal(
      secondKeys.programId.toBase58(),
    );
    expect(firstKeys.vault.toBase58()).to.equal(secondKeys.vault.toBase58());
  });

  it('returns fresh immutable squads key containers per resolved-chain lookup', () => {
    const firstKeys = getSquadsKeysForResolvedChain('solanamainnet');
    const secondKeys = getSquadsKeysForResolvedChain('solanamainnet');

    expect(firstKeys).to.not.equal(secondKeys);
    expect(Object.isFrozen(firstKeys)).to.equal(true);
    expect(Object.isFrozen(secondKeys)).to.equal(true);
    expect(firstKeys.multisigPda.toBase58()).to.equal(
      secondKeys.multisigPda.toBase58(),
    );
    expect(firstKeys.programId.toBase58()).to.equal(
      secondKeys.programId.toBase58(),
    );
    expect(firstKeys.vault.toBase58()).to.equal(secondKeys.vault.toBase58());
  });

  it('keeps resolved-chain and string-chain key lookups aligned for every squads chain', () => {
    for (const chain of getSquadsChains()) {
      const resolvedLookup = getSquadsKeysForResolvedChain(chain);
      const stringLookup = getSquadsKeys(chain);

      expect(resolvedLookup.multisigPda.toBase58()).to.equal(
        stringLookup.multisigPda.toBase58(),
      );
      expect(resolvedLookup.programId.toBase58()).to.equal(
        stringLookup.programId.toBase58(),
      );
      expect(resolvedLookup.vault.toBase58()).to.equal(
        stringLookup.vault.toBase58(),
      );
    }
  });

  it('rejects malformed runtime values in resolved-chain key lookups', () => {
    expect(() => getSquadsKeysForResolvedChain('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain',
    );
    expect(() => getSquadsKeysForResolvedChain(1)).to.throw(
      'Expected chain name to be a string, got number',
    );
  });

  it('throws for unknown chain key lookups', () => {
    expect(() => getSquadsKeys('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain',
    );
  });
});
