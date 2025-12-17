import { expect } from 'chai';

import { DispatchedMessage, MultiProvider } from '@hyperlane-xyz/sdk';

import { filterRelayableMessages } from './message.js';

describe('filterRelayableMessages', () => {
  function createMockMessage(
    id: string,
    destinationChain?: string,
  ): DispatchedMessage {
    return {
      id,
      message: '0x',
      parsed: {
        version: 0,
        nonce: 0,
        origin: 1,
        sender: '0x0000000000000000000000000000000000000001',
        destination: 2,
        recipient: '0x0000000000000000000000000000000000000002',
        body: '0x',
        destinationChain,
      },
    } as DispatchedMessage;
  }

  function createMockMultiProvider(signersForChains: string[]): MultiProvider {
    return {
      tryGetSigner: (chain: string) => {
        if (signersForChains.includes(chain)) {
          return {} as any; // Return a truthy value to indicate signer exists
        }
        return undefined;
      },
    } as unknown as MultiProvider;
  }

  it('returns message as relayable when signer exists for destination', () => {
    const message = createMockMessage('msg1', 'ethereum');
    const multiProvider = createMockMultiProvider(['ethereum']);

    const result = filterRelayableMessages([message], multiProvider);

    expect(result.relayable).to.have.lengthOf(1);
    expect(result.relayable[0].id).to.equal('msg1');
    expect(result.skipped).to.have.lengthOf(0);
  });

  it('returns message as skipped when no signer exists for destination', () => {
    const message = createMockMessage('msg1', 'celestia');
    const multiProvider = createMockMultiProvider(['ethereum']);

    const result = filterRelayableMessages([message], multiProvider);

    expect(result.relayable).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
    expect(result.skipped[0].id).to.equal('msg1');
  });

  it('returns message as skipped when destinationChain is undefined', () => {
    const message = createMockMessage('msg1', undefined);
    const multiProvider = createMockMultiProvider(['ethereum']);

    const result = filterRelayableMessages([message], multiProvider);

    expect(result.relayable).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(1);
  });

  it('correctly partitions multiple messages', () => {
    const msg1 = createMockMessage('msg1', 'ethereum');
    const msg2 = createMockMessage('msg2', 'celestia');
    const msg3 = createMockMessage('msg3', 'arbitrum');
    const msg4 = createMockMessage('msg4', undefined);

    const multiProvider = createMockMultiProvider(['ethereum', 'arbitrum']);

    const result = filterRelayableMessages(
      [msg1, msg2, msg3, msg4],
      multiProvider,
    );

    expect(result.relayable).to.have.lengthOf(2);
    expect(result.relayable.map((m) => m.id)).to.deep.equal(['msg1', 'msg3']);
    expect(result.skipped).to.have.lengthOf(2);
    expect(result.skipped.map((m) => m.id)).to.deep.equal(['msg2', 'msg4']);
  });

  it('returns empty arrays when no messages provided', () => {
    const multiProvider = createMockMultiProvider([]);

    const result = filterRelayableMessages([], multiProvider);

    expect(result.relayable).to.have.lengthOf(0);
    expect(result.skipped).to.have.lengthOf(0);
  });
});
