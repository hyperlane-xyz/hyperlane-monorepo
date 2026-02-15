import { PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import {
  assertIsSquadsChain,
  getSquadsChains,
  getSquadsKeys,
  getUnsupportedSquadsChainsErrorMessage,
  isSquadsChain,
  partitionSquadsChains,
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
  });

  it('asserts supported chains with helpful error context', () => {
    expect(() => assertIsSquadsChain('solanamainnet')).to.not.throw();
    expect(() => assertIsSquadsChain('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain. Available Squads chains: solanamainnet, soon, eclipsemainnet, sonicsvm, solaxy',
    );
  });

  it('partitions chains with dedupe and first-seen ordering', () => {
    expect(
      partitionSquadsChains([
        'unknown-b',
        'solanamainnet',
        'unknown-a',
        'soon',
        'unknown-b',
        'solanamainnet',
      ]),
    ).to.deep.equal({
      squadsChains: ['solanamainnet', 'soon'],
      nonSquadsChains: ['unknown-b', 'unknown-a'],
    });
  });

  it('rejects malformed partition inputs with index-aware types', () => {
    expect(() =>
      partitionSquadsChains('solanamainnet' as unknown as readonly string[]),
    ).to.throw('Expected partitioned squads chains to be an array, got string');

    expect(() =>
      partitionSquadsChains([
        'solanamainnet',
        null as unknown as string,
      ] as readonly string[]),
    ).to.throw('Expected partitioned squads chains[1] to be a string, got null');
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
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(
        'ethereum' as unknown as readonly string[],
      ),
    ).to.throw('Expected unsupported squads chains to be an array, got string');
    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(
        null as unknown as readonly string[],
      ),
    ).to.throw('Expected unsupported squads chains to be an array, got null');

    expect(() =>
      getUnsupportedSquadsChainsErrorMessage(['ethereum'], []),
    ).to.throw('Expected at least one configured squads chain');

    expect(() =>
      getUnsupportedSquadsChainsErrorMessage([]),
    ).to.throw(
      'Expected at least one unsupported squads chain to format error message',
    );
  });

  it('resolves explicit chains and defaults while validating runtime input', () => {
    expect(resolveSquadsChains()).to.deep.equal(getSquadsChains());
    expect(resolveSquadsChains([])).to.deep.equal(getSquadsChains());
    expect(resolveSquadsChains([' solanamainnet ', 'solanamainnet'])).to.deep
      .equal(['solanamainnet']);

    expect(() =>
      resolveSquadsChains('solanamainnet' as unknown as readonly string[]),
    ).to.throw('Expected squads chains to be an array, got string');
    expect(() =>
      resolveSquadsChains(null as unknown as readonly string[]),
    ).to.throw('Expected squads chains to be an array, got null');
    expect(() =>
      resolveSquadsChains([
        'solanamainnet',
        1 as unknown as string,
      ] as readonly string[]),
    ).to.throw('Expected squads chains[1] to be a string, got number');
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

  it('throws for unknown chain key lookups', () => {
    expect(() => getSquadsKeys('unknown-chain')).to.throw(
      'Squads config not found on chain unknown-chain',
    );
  });
});
