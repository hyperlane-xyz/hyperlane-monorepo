import { ethers } from 'ethers';

import {
  CircleBridgeAdapter__factory,
  ICircleMessageTransmitter__factory,
  ITokenMessenger__factory,
  Mailbox__factory,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import {
  addressToBytes32,
  ensure0x,
  eqAddress,
  rootLogger,
  strip0x,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../app/HyperlaneApp.js';
import { HyperlaneContracts } from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../../types.js';
import { fetchWithTimeout } from '../../utils/fetch.js';

import { BridgeAdapterConfig } from './LiquidityLayerRouterDeployer.js';
import { liquidityLayerFactories } from './contracts.js';

const logger = rootLogger.child({ module: 'LiquidityLayerApp' });

const PORTAL_VAA_SERVICE_TESTNET_BASE_URL =
  'https://wormhole-v2-testnet-api.certus.one/v1/signed_vaa/';
const CIRCLE_ATTESTATIONS_TESTNET_BASE_URL =
  'https://iris-api-sandbox.circle.com/attestations/';
const CIRCLE_ATTESTATIONS_MAINNET_BASE_URL =
  'https://iris-api.circle.com/attestations/';

const PORTAL_VAA_SERVICE_SUCCESS_CODE = 5;

const TokenMessengerInterface = ITokenMessenger__factory.createInterface();
const CircleBridgeAdapterInterface =
  CircleBridgeAdapter__factory.createInterface();
const PortalAdapterInterface = PortalAdapter__factory.createInterface();
const MailboxInterface = Mailbox__factory.createInterface();

const BridgedTokenTopic = CircleBridgeAdapterInterface.getEventTopic(
  CircleBridgeAdapterInterface.getEvent('BridgedToken'),
);

const PortalBridgedTokenTopic = PortalAdapterInterface.getEventTopic(
  PortalAdapterInterface.getEvent('BridgedToken'),
);

interface CircleBridgeMessage {
  chain: ChainName;
  remoteChain: ChainName;
  txHash: string;
  message: string;
  nonce: number;
  domain: number;
  nonceHash: string;
}

interface PortalBridgeMessage {
  origin: ChainName;
  nonce: number;
  portalSequence: number;
  destination: ChainName;
}

export class LiquidityLayerApp extends HyperlaneApp<
  typeof liquidityLayerFactories
> {
  constructor(
    public readonly contractsMap: ChainMap<
      HyperlaneContracts<typeof liquidityLayerFactories>
    >,
    public readonly multiProvider: MultiProvider,
    public readonly config: ChainMap<BridgeAdapterConfig>,
  ) {
    super(contractsMap, multiProvider);
  }

  async fetchCircleMessageTransactions(chain: ChainName): Promise<string[]> {
    logger.info(`Fetch circle messages for ${chain}`);
    const url = new URL(this.multiProvider.getExplorerApiUrl(chain));
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    url.searchParams.set(
      'address',
      this.getContracts(chain).circleBridgeAdapter!.address,
    );
    url.searchParams.set('topic0', BridgedTokenTopic);
    const req = await fetchWithTimeout(url);
    const response = await req.json();

    return response.result.map((tx: any) => tx.transactionHash).flat();
  }

  async fetchPortalBridgeTransactions(chain: ChainName): Promise<string[]> {
    const url = new URL(this.multiProvider.getExplorerApiUrl(chain));
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    url.searchParams.set(
      'address',
      this.getContracts(chain).portalAdapter!.address,
    );
    url.searchParams.set('topic0', PortalBridgedTokenTopic);
    const req = await fetchWithTimeout(url);
    const response = await req.json();

    if (!response.result) {
      throw Error(`Expected result in response: ${response}`);
    }

    return response.result.map((tx: any) => tx.transactionHash).flat();
  }

  async parsePortalMessages(
    chain: ChainName,
    txHash: string,
  ): Promise<PortalBridgeMessage[]> {
    const provider = this.multiProvider.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((log) => {
        try {
          return [PortalAdapterInterface.parseLog(log)];
        } catch {
          return [];
        }
      })
      .flat();
    if (matchingLogs.length == 0) return [];

    const event = matchingLogs.find((log) => log!.name === 'BridgedToken')!;
    const portalSequence = event.args.portalSequence.toNumber();
    const nonce = event.args.nonce.toNumber();
    const destination = this.multiProvider.getChainName(event.args.destination);

    return [{ origin: chain, nonce, portalSequence, destination }];
  }

  async parseCircleMessages(
    chain: ChainName,
    txHash: string,
  ): Promise<CircleBridgeMessage[]> {
    logger.debug(`Parse Circle messages for chain ${chain} ${txHash}`);
    const provider = this.multiProvider.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((log) => {
        try {
          return [TokenMessengerInterface.parseLog(log)];
        } catch {
          try {
            return [CircleBridgeAdapterInterface.parseLog(log)];
          } catch {
            try {
              return [MailboxInterface.parseLog(log)];
            } catch {
              return [];
            }
          }
        }
      })
      .flat();

    if (matchingLogs.length == 0) return [];
    const message = matchingLogs.find((log) => log!.name === 'MessageSent')!
      .args.message;
    const nonce = matchingLogs.find((log) => log!.name === 'BridgedToken')!.args
      .nonce;

    const destinationDomain = matchingLogs.find(
      (log) => log!.name === 'Dispatch',
    )!.args.destination;

    const remoteChain = this.multiProvider.getChainName(destinationDomain);
    const domain = this.config[chain].circle!.circleDomainMapping.find(
      (mapping) =>
        mapping.hyperlaneDomain === this.multiProvider.getDomainId(chain),
    )!.circleDomain;
    return [
      {
        chain,
        remoteChain,
        txHash,
        message,
        nonce,
        domain,
        nonceHash: ethers.utils.solidityKeccak256(
          ['uint32', 'uint64'],
          [domain, nonce],
        ),
      },
    ];
  }

  async attemptPortalTransferCompletion(
    message: PortalBridgeMessage,
  ): Promise<void> {
    const destinationPortalAdapter = this.getContracts(
      message.destination,
    ).portalAdapter!;

    const transferId = await destinationPortalAdapter.transferId(
      this.multiProvider.getDomainId(message.origin),
      message.nonce,
    );

    const transferTokenAddress =
      await destinationPortalAdapter.portalTransfersProcessed(transferId);

    if (!eqAddress(transferTokenAddress, ethers.constants.AddressZero)) {
      logger.info(
        `Transfer with nonce ${message.nonce} from ${message.origin} to ${message.destination} already processed`,
      );
      return;
    }

    const wormholeOriginDomain = this.config[
      message.destination
    ].portal!.wormholeDomainMapping.find(
      (mapping) =>
        mapping.hyperlaneDomain ===
        this.multiProvider.getDomainId(message.origin),
    )?.wormholeDomain;
    const emitter = strip0x(
      addressToBytes32(this.config[message.origin].portal!.portalBridgeAddress),
    );

    const vaa = await fetchWithTimeout(
      `${PORTAL_VAA_SERVICE_TESTNET_BASE_URL}${wormholeOriginDomain}/${emitter}/${message.portalSequence}`,
    ).then((response) => response.json());

    if (vaa.code && vaa.code === PORTAL_VAA_SERVICE_SUCCESS_CODE) {
      logger.info(`VAA not yet found for nonce ${message.nonce}`);
      return;
    }

    logger.debug(
      `Complete portal transfer for nonce ${message.nonce} on ${message.destination}`,
    );

    try {
      await this.multiProvider.handleTx(
        message.destination,
        destinationPortalAdapter.completeTransfer(
          ensure0x(Buffer.from(vaa.vaaBytes, 'base64').toString('hex')),
        ),
      );
    } catch (error: any) {
      if (error?.error?.reason?.includes('no wrapper for this token')) {
        logger.info(
          'No wrapper for this token, you should register the token at https://wormhole-foundation.github.io/example-token-bridge-ui/#/register',
        );
        logger.info(message);
        return;
      }
      throw error;
    }
  }

  async attemptCircleAttestationSubmission(
    message: CircleBridgeMessage,
  ): Promise<void> {
    const signer = this.multiProvider.getSigner(message.remoteChain);
    const transmitter = ICircleMessageTransmitter__factory.connect(
      this.config[message.remoteChain].circle!.messageTransmitterAddress,
      signer,
    );

    const alreadyProcessed = await transmitter.usedNonces(message.nonceHash);

    if (alreadyProcessed) {
      logger.info(`Message sent on ${message.txHash} was already processed`);
      return;
    }

    logger.info(`Attempt Circle message delivery`, JSON.stringify(message));

    const messageHash = ethers.utils.keccak256(message.message);
    const baseurl = this.multiProvider.getChainMetadata(message.chain).isTestnet
      ? CIRCLE_ATTESTATIONS_TESTNET_BASE_URL
      : CIRCLE_ATTESTATIONS_MAINNET_BASE_URL;
    const attestationsB = await fetchWithTimeout(`${baseurl}${messageHash}`);
    const attestations = await attestationsB.json();

    if (attestations.status !== 'complete') {
      logger.info(
        `Attestations not available for message nonce ${message.nonce} on ${message.txHash}`,
      );
      return;
    }
    logger.info(`Ready to submit attestations for message ${message.nonce}`);

    const tx = await transmitter.receiveMessage(
      message.message,
      attestations.attestation,
    );

    logger.info(
      `Submitted attestations in ${this.multiProvider.tryGetExplorerTxUrl(
        message.remoteChain,
        tx,
      )}`,
    );
    await this.multiProvider.handleTx(message.remoteChain, tx);
  }
}
