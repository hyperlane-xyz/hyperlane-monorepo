import { Keypair, PublicKey } from '@solana/web3.js';
import { expect } from 'chai';

import { TestChainName, testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { SealevelCoreAdapter } from './SealevelCoreAdapter.js';

describe('SealevelCoreAdapter', () => {
  it('builds a permissionless claim to the configured protocol fee beneficiary', () => {
    const mailbox = Keypair.generate().publicKey;
    const beneficiary = Keypair.generate().publicKey;
    const adapter = new SealevelCoreAdapter(
      TestChainName.test1,
      new MultiProtocolProvider(testChainMetadata),
      { mailbox: mailbox.toBase58() },
    );

    const instruction = adapter.createClaimProtocolFeesInstruction(
      mailbox,
      beneficiary,
    );
    const [outbox] = PublicKey.findProgramAddressSync(
      [Buffer.from('hyperlane'), Buffer.from('-'), Buffer.from('outbox')],
      mailbox,
    );

    expect(instruction.programId.equals(mailbox)).to.be.true;
    // Borsh enum variant 10 in the Rust mailbox instruction ABI.
    expect([...instruction.data]).to.eql([10]);
    expect(instruction.keys).to.eql([
      { pubkey: outbox, isSigner: false, isWritable: true },
      { pubkey: beneficiary, isSigner: false, isWritable: true },
    ]);
  });

  describe('parses dispatch messages', () => {
    it('finds message id', async () => {
      expect(
        SealevelCoreAdapter.parseMessageDispatchLogs([
          'Dispatched message to 123, ID abc',
        ]),
      ).to.eql([{ destination: '123', messageId: 'abc' }]);
    });
    it('Skips invalid', async () => {
      expect(SealevelCoreAdapter.parseMessageDispatchLogs([])).to.eql([]);
      expect(
        SealevelCoreAdapter.parseMessageDispatchLogs(['foo', 'bar']),
      ).to.eql([]);
    });
  });
});
