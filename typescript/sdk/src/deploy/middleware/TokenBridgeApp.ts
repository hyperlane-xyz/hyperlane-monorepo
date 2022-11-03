import fetch from 'cross-fetch';
import { ethers } from 'ethers';

import {
  CircleBridgeAdapter__factory,
  ICircleBridge__factory,
  ICircleMessageTransmitter__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneApp } from '../../HyperlaneApp';
import { Chains } from '../../consts/chains';
import { TokenBridgeContracts } from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { objMap } from '../../utils/objects';

import {
  BridgeAdapterConfig,
  BridgeAdapterType,
  CircleBridgeAdapterConfig,
} from './TokenBridgeRouterDeployer';

const CircleBridgeInterface = ICircleBridge__factory.createInterface();
const CircleBridgeAdapterInterface =
  CircleBridgeAdapter__factory.createInterface();

interface CircleBridgeMessage<Chain> {
  chain: Chain;
  remoteChain: Chain;
  txHash: string;
  message: string;
  nonce: number;
  domain: number;
  nonceHash: string;
}
export class TokenBridgeApp<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<TokenBridgeContracts, Chain> {
  constructor(
    public readonly contractsMap: ChainMap<Chain, TokenBridgeContracts>,
    public readonly multiProvider: MultiProvider<Chain>,
    public readonly bridgeAdapterConfigs: ChainMap<
      Chain,
      BridgeAdapterConfig[]
    >,
  ) {
    super(contractsMap, multiProvider);
  }

  circleBridgeAdapterConfig(): ChainMap<Chain, CircleBridgeAdapterConfig> {
    return objMap(
      this.bridgeAdapterConfigs,
      (_chain, config) =>
        config.find(
          (_) => _.type === BridgeAdapterType.Circle,
        ) as CircleBridgeAdapterConfig,
    );
  }

  async fetchCircleMessageTransactions(chain: Chain): Promise<string[]> {
    const cc = this.multiProvider.getChainConnection(chain);
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address: this.getContracts(chain).circleBridgeAdapter!.address,
      topic0: CircleBridgeAdapterInterface.getEventTopic(
        CircleBridgeAdapterInterface.getEvent('BridgedToken'),
      ),
    });
    const req = await fetch(`${cc.getApiUrl()}?${params}`);
    const response = await req.json();

    return response.result.map((_: any) => _.transactionHash).flat();
  }

  async parseCircleMessages(
    chain: Chain,
    txHash: string,
  ): Promise<CircleBridgeMessage<Chain>[]> {
    const connection = this.multiProvider.getChainConnection(chain);
    const receipt = await connection.provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((_) => {
        try {
          return [CircleBridgeInterface.parseLog(_)];
        } catch {
          try {
            return [CircleBridgeAdapterInterface.parseLog(_)];
          } catch {
            return [];
          }
        }
      })
      .flat();

    if (matchingLogs.length == 0) return [];
    const message = matchingLogs.find((_) => _!.name === 'MessageSent')!.args
      .message;
    const nonce = matchingLogs.find((_) => _!.name === 'BridgedToken')!.args
      .nonce;
    const remoteChain =
      message.chain === Chains.fuji ? Chains.goerli : Chains.fuji;
    return [
      {
        chain,
        // @ts-ignore
        remoteChain,
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
  }

  async attemptCircleAttestationSubmission(
    message: CircleBridgeMessage<Chain>,
  ): Promise<void> {
    const connection = this.multiProvider.getChainConnection(
      message.remoteChain,
    );
    const transmitter = ICircleMessageTransmitter__factory.connect(
      this.circleBridgeAdapterConfig()[message.remoteChain]
        .messageTransmitterAddress,
      connection.signer!,
    );

    const alreadyProcessed = await transmitter.usedNonces(message.nonceHash);

    if (alreadyProcessed) {
      console.log(`Message sent on ${message.txHash} was already processed`);
      return;
    }

    const messageHash = ethers.utils.keccak256(message.message);
    const attestationsB = await fetch(
      `https://iris-api-sandbox.circle.com/attestations/${messageHash}`,
    );
    const attestations = await attestationsB.json();

    if (attestations.status !== 'complete') {
      console.log(
        `Attestations not available for message nonce ${message.nonce} on ${message.txHash}`,
      );
      return;
    }
    console.log(`Ready to submit attestations for message ${message.nonce}`);

    const tx = await transmitter.receiveMessage(
      message.message,
      attestations.attestation,
    );

    console.log(`Submitted attestations in ${await connection.getTxUrl(tx)}`);
    await tx.wait(1);
  }
}
