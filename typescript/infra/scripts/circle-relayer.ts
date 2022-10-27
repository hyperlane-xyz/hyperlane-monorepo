import fetch from 'cross-fetch';
import { ethers } from 'ethers';

import { Chains } from '@hyperlane-xyz/sdk';

import { sleep } from '../src/utils/utils';

import { getCoreEnvironmentConfig, getEnvironment } from './utils';

const MessageTransmitterInterface = new ethers.utils.Interface([
  'event MessageSent(bytes message)',
  'event BridgedToken(uint64 nonce)',
  'function usedNonces(bytes32 nonce) view returns (bool)',
]);

const CircleBridgeInterface = new ethers.utils.Interface([
  'function receiveCircleMessage(bytes,bytes)',
]);
const FujiMessageTransmitter = '0x52fffb3ee8fa7838e9858a2d5e454007b9027c3c';
const FujiCircleBridge = '0xb9E7682C155b5A6E37EeE6D91E7366468aF8f588';

export const ChainToDomain = {
  [Chains.goerli]: 0,
  [Chains.fuji]: 1,
};

export const DomainToChain = {
  [0]: Chains.goerli,
  [1]: Chains.fuji,
};

async function check() {
  const environment = await getEnvironment();
  const config = getCoreEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // const chains = [Chains.goerli, Chains.fuji]

  async function grabCircleMessageDispatches(chain: Chains) {
    const cc = multiProvider.getChainConnection(chain);
    const params = new URLSearchParams({
      // apikey: this.apiKeys[chain],
      module: 'logs',
      action: 'getLogs',
      address: '0x0e587eE9A0Bc4107C98A15A9F11220D11aCCF994',
      topic0:
        '0x958169e70ad37a5321c6f6e1b72d9e69b1c2743be96a3321f80a1118e08c8ea9',
    });
    const req = await fetch(`${cc.getApiUrl()}?${params}`);
    return await req.json();
  }

  while (true) {
    const cc = multiProvider.getChainConnection(Chains.goerli);
    const dispatches = await grabCircleMessageDispatches(Chains.goerli);
    const txHashes: string[] = dispatches.result
      .map((_: any) => _.transactionHash)
      .flat();
    const circleDispatches = (
      await Promise.all(
        txHashes.map(async (txHash) => {
          const receipt = await cc.provider.getTransactionReceipt(txHash);
          const matchingLogs = receipt.logs
            .map((_) => {
              try {
                return [MessageTransmitterInterface.parseLog(_)];
              } catch {
                return [];
              }
            })
            .flat();
          if (matchingLogs.length == 0) return [];
          const message = matchingLogs.find((_) => _!.name === 'MessageSent')!
            .args.message;
          const nonce = matchingLogs.find((_) => _!.name === 'BridgedToken')!
            .args.nonce;
          return [
            {
              txHash,
              message,
              nonce,
              domain: 0,
              nonceHash: ethers.utils.solidityKeccak256(
                ['uint32', 'uint256'],
                [0, nonce],
              ),
            },
          ];
        }),
      )
    ).flat();

    // Poll for attestation data and submit
    await Promise.all(
      circleDispatches.map(async (d) => {
        const ac = multiProvider.getChainConnection(Chains.fuji);
        const transmitter = new ethers.Contract(
          FujiMessageTransmitter,
          MessageTransmitterInterface,
          ac.provider,
        );
        const alreadyProcessed = await transmitter.usedNonces(d.nonceHash);

        if (alreadyProcessed) {
          console.log(`Message sent on ${d.txHash} was already processed`);
          return;
        }

        const messageHash = ethers.utils.keccak256(d!.message);
        const attestationsB = await fetch(
          `https://iris-api-sandbox.circle.com/attestations/${messageHash}`,
        );
        const attestations = await attestationsB.json();

        if (attestations.status !== 'complete') {
          console.log(
            `Attestations not available for message nonce ${d.nonce} on ${d.txHash}`,
          );
        }
        console.log(`Ready to submit attestations for message ${d.nonce}}`);

        const circleBridgeAdapter = new ethers.Contract(
          FujiCircleBridge,
          CircleBridgeInterface,
          ac.signer!,
        );
        const tx = await circleBridgeAdapter.receiveCircleMessage(
          d.message,
          attestations.attestation,
        );

        console.log(`Submitted attestations in ${await ac.getTxUrl(tx)}`);
        await tx.wait(1);
      }),
    );

    await sleep(6000);
  }
}

check().then(console.log).catch(console.error);
