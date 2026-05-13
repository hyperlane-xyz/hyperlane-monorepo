import { type Address, address } from '@solana/kit';
import { expect } from 'chai';

import {
  SPL_NOOP_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';
import { DEFAULT_IGP_SALT, deriveIgpSalt } from '../hook/igp-hook.js';
import {
  deriveIgpAccountPda,
  deriveIgpProgramDataPda,
  deriveMailboxOutboxPda,
  deriveOverheadIgpAccountPda,
} from '../pda.js';

import { deriveCoreDeploymentAltAddresses } from './warp-alt.js';

const MAILBOX: Address = address(
  'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
);
const IGP_PROGRAM: Address = address(
  'BCYqLqWsXmA3sP7VBR1G64rUQXqXM6JzkqpYxbFv5Yu1',
);
const ALT_IGP_SALT = deriveIgpSalt('warp-alt-test:alt-salt');

function isSortedAscending<T extends string>(items: T[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (items[i - 1]! >= items[i]!) return false;
  }
  return true;
}

describe('deriveCoreDeploymentAltAddresses', () => {
  it('returns sdk constants + mailbox/outbox without igp', async () => {
    const outbox = (await deriveMailboxOutboxPda(MAILBOX)).address;
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX);

    expect(result).to.have.lengthOf(5);
    expect(new Set(result)).to.deep.equal(
      new Set([
        SYSTEM_PROGRAM_ADDRESS,
        SPL_NOOP_PROGRAM_ADDRESS,
        SPL_TOKEN_PROGRAM_ADDRESS,
        MAILBOX,
        outbox,
      ]),
    );
  });

  it('adds igp program + program data + igp account when igp ctx supplied', async () => {
    const programData = (await deriveIgpProgramDataPda(IGP_PROGRAM)).address;
    const igpAccount = (
      await deriveIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT)
    ).address;

    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
    });

    expect(result).to.have.lengthOf(8);
    expect(result).to.include.members([IGP_PROGRAM, programData, igpAccount]);
  });

  it('adds overhead-igp account when includeOverheadIgp is set', async () => {
    const overhead = (
      await deriveOverheadIgpAccountPda(IGP_PROGRAM, DEFAULT_IGP_SALT)
    ).address;

    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
      includeOverheadIgp: true,
    });

    expect(result).to.have.lengthOf(9);
    expect(result).to.include(overhead);
  });

  it('output is sorted ascending and contains no duplicates', async () => {
    const result = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
      includeOverheadIgp: true,
    });

    expect(isSortedAscending([...result])).to.equal(
      true,
      `expected ascending order, got: ${result.join(', ')}`,
    );
    expect(new Set(result).size).to.equal(result.length);
  });

  it('different igp salts produce different igp account entries', async () => {
    const a = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: DEFAULT_IGP_SALT,
    });
    const b = await deriveCoreDeploymentAltAddresses(MAILBOX, {
      programId: IGP_PROGRAM,
      igpSalt: ALT_IGP_SALT,
    });

    const aSet = new Set(a);
    const bSet = new Set(b);
    const onlyInA = [...aSet].filter((addr) => !bSet.has(addr));
    const onlyInB = [...bSet].filter((addr) => !aSet.has(addr));

    expect(
      onlyInA,
      'expected exactly one address unique to set A',
    ).to.have.lengthOf(1);
    expect(
      onlyInB,
      'expected exactly one address unique to set B',
    ).to.have.lengthOf(1);
  });
});
