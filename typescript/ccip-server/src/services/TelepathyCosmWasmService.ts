import { ethers } from 'ethers';
import { Router } from 'express';
import { Logger } from 'pino';
import { z } from 'zod';

import { MultiProvider } from '@hyperlane-xyz/sdk';
import { parseMessage } from '@hyperlane-xyz/utils';

import {
  BaseService,
  REGISTRY_URI_SCHEMA,
  ServiceConfigWithMultiProvider,
} from './BaseService.js';
import { HyperlaneService } from './HyperlaneService.js';

const EnvSchema = z.object({
  HYPERLANE_EXPLORER_URL: z.string().url().optional(),
  DISPATCHED_HOOK_ADDRESS: z.string().optional(),
  REGISTRY_URI: REGISTRY_URI_SCHEMA,
});

export const ETHEREUM_GENESIS_TIME = 1606824023n; // Ethereum Beacon Chain Genesis Time (Dec 1, 2020)
export const SECONDS_PER_SLOT = 12n;

/**
 * Calculates the Ethereum Beacon Chain slot corresponding to an execution block timestamp.
 */
export function calculateBeaconSlot(
  timestamp: bigint,
  genesisTime: bigint = ETHEREUM_GENESIS_TIME,
  secondsPerSlot: bigint = SECONDS_PER_SLOT,
): bigint {
  if (timestamp < genesisTime) {
    throw new Error(
      `Timestamp ${timestamp} is before beacon chain genesis time ${genesisTime}`,
    );
  }
  return (timestamp - genesisTime) / secondsPerSlot;
}

/**
 * Calculates Solidity storage slot key for mapping(uint32 => bytes32) dispatched at slotIndex.
 * Formula: keccak256(abi.encode(bytes32(nonce), bytes32(slotIndex)))
 */
export function calculateDispatchedStorageSlot(
  nonce: number | bigint,
  slotIndex: number = 0,
): string {
  const nonceHex = ethers.utils.hexZeroPad(
    ethers.BigNumber.from(nonce).toHexString(),
    32,
  );
  const slotIndexHex = ethers.utils.hexZeroPad(
    ethers.BigNumber.from(slotIndex).toHexString(),
    32,
  );
  return ethers.utils.keccak256(ethers.utils.concat([nonceHex, slotIndexHex]));
}

/**
 * RLP encodes a list of hex-encoded trie proof node strings into RLP list bytes.
 */
export function rlpEncodeProofNodes(proofNodes: string[]): Uint8Array {
  return ethers.utils.arrayify(
    ethers.utils.RLP.encode(proofNodes.map((n) => ethers.utils.arrayify(n))),
  );
}

/**
 * Encodes the proof payload into the exact metadata layout expected by cw-hyperlane-telepathy-ism:
 * [slot: 8 bytes] [account_proof_len: 2 bytes] [account_proof_rlp] [storage_proof_len: 2 bytes] [storage_proof_rlp]
 */
export function encodeCosmWasmTelepathyMetadata(
  slot: bigint,
  accountProof: string[],
  storageProof: string[],
): string {
  const slotBytes = ethers.utils.zeroPad(
    ethers.BigNumber.from(slot).toHexString(),
    8,
  );
  const accountProofRlp = rlpEncodeProofNodes(accountProof);
  const storageProofRlp = rlpEncodeProofNodes(storageProof);

  const accountProofLen = ethers.utils.zeroPad(
    ethers.BigNumber.from(accountProofRlp.length).toHexString(),
    2,
  );
  const storageProofLen = ethers.utils.zeroPad(
    ethers.BigNumber.from(storageProofRlp.length).toHexString(),
    2,
  );

  const combined = ethers.utils.concat([
    slotBytes,
    accountProofLen,
    accountProofRlp,
    storageProofLen,
    storageProofRlp,
  ]);

  return ethers.utils.hexlify(combined);
}

export class TelepathyCosmWasmService extends BaseService {
  public router: Router;
  private hyperlaneService?: HyperlaneService;
  private multiProvider: MultiProvider;
  private defaultDispatchedHook?: string;

  static async create(serviceName: string): Promise<TelepathyCosmWasmService> {
    const env = EnvSchema.parse(process.env);
    const multiProvider = await BaseService.getMultiProvider(env.REGISTRY_URI);

    return new TelepathyCosmWasmService({
      serviceName,
      multiProvider,
    });
  }

  constructor(config: ServiceConfigWithMultiProvider) {
    super(config);
    this.multiProvider = config.multiProvider;

    const env = EnvSchema.parse(process.env);
    if (env.HYPERLANE_EXPLORER_URL) {
      this.hyperlaneService = new HyperlaneService(
        this.config.serviceName,
        env.HYPERLANE_EXPLORER_URL,
      );
    }
    this.defaultDispatchedHook = env.DISPATCHED_HOOK_ADDRESS;

    this.router = Router();

    // CCIP-read GET endpoint: /getProof/:sender/:callData.json
    this.router.get('/getProof/:sender/:callData.json', async (req, res) => {
      try {
        const callData = req.params.callData;
        const metadata = await this.getTelepathyProof(
          callData,
          undefined,
          req.log,
        );
        return res.json({ data: metadata });
      } catch (err: any) {
        req.log.error(
          { error: err.message },
          'Failed to fetch proof in GET handler',
        );
        return res.status(500).json({ error: err.message });
      }
    });

    // CCIP-read POST endpoint: /getProof
    this.router.post('/getProof', async (req, res) => {
      try {
        const message =
          req.body?.data || req.body?.message || req.body?.callData;
        const originTxHash = req.body?.origin_tx_hash;
        if (!message) {
          return res
            .status(400)
            .json({ error: 'Missing message in request body' });
        }
        const metadata = await this.getTelepathyProof(
          message,
          originTxHash,
          req.log,
        );
        return res.json({ data: metadata });
      } catch (err: any) {
        req.log.error(
          { error: err.message },
          'Failed to fetch proof in POST handler',
        );
        return res.status(500).json({ error: err.message });
      }
    });

    // Helper endpoint: /fetchProofByParams
    this.router.get(
      '/fetchProofByParams/:originDomain/:dispatchedHook/:nonce/:slot',
      async (req, res) => {
        try {
          const originDomain = parseInt(req.params.originDomain);
          const dispatchedHook = req.params.dispatchedHook;
          const nonce = parseInt(req.params.nonce);
          const slot = BigInt(req.params.slot);

          const metadata = await this.fetchEthProofAndEncode(
            originDomain,
            dispatchedHook,
            nonce,
            slot,
            req.log,
          );
          return res.json({ metadata, slot: slot.toString() });
        } catch (err: any) {
          req.log.error(
            { error: err.message },
            'Failed to fetch proof by params',
          );
          return res.status(500).json({ error: err.message });
        }
      },
    );
  }

  /**
   * Main proof generation method from Hyperlane message
   */
  async getTelepathyProof(
    message: string,
    originTxHash: string | undefined,
    logger?: Logger,
  ): Promise<string> {
    const log = logger ? this.addLoggerServiceContext(logger) : undefined;
    log?.info({ message }, 'Generating Telepathy CosmWasm proof');

    const parsed = parseMessage(message);
    const messageId = ethers.utils.keccak256(message);

    let txHash: string | undefined = originTxHash;
    if (!txHash && this.hyperlaneService) {
      log?.info({ messageId }, 'Querying explorer for dispatch tx hash');
      txHash = await this.hyperlaneService.getOriginTransactionHashByMessageId(
        messageId,
        log!,
      );
    }

    if (!txHash) {
      throw new Error(
        `Could not determine origin transaction hash for message ${messageId}`,
      );
    }

    const provider = this.multiProvider.getProvider(parsed.origin);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      throw new Error(
        `Receipt not found for tx ${txHash} on origin domain ${parsed.origin}`,
      );
    }

    const block = await provider.getBlock(receipt.blockNumber);
    const slot = calculateBeaconSlot(BigInt(block.timestamp));

    const dispatchedHookAddress = this.defaultDispatchedHook || parsed.sender;
    return this.fetchEthProofAndEncode(
      parsed.origin,
      dispatchedHookAddress,
      parsed.nonce,
      slot,
      log,
      receipt.blockNumber,
    );
  }

  /**
   * Fetches eth_getProof from origin RPC and encodes CosmWasm metadata
   */
  async fetchEthProofAndEncode(
    originDomain: number,
    dispatchedHookAddress: string,
    nonce: number,
    slot: bigint,
    logger?: Logger,
    blockNumber?: number,
  ): Promise<string> {
    const provider = this.multiProvider.getProvider(originDomain);
    const storageSlot = calculateDispatchedStorageSlot(nonce, 0);

    const blockTag = blockNumber
      ? ethers.utils.hexValue(blockNumber)
      : 'latest';
    logger?.info(
      {
        originDomain,
        dispatchedHookAddress,
        storageSlot,
        blockTag,
        slot: slot.toString(),
      },
      'Calling eth_getProof on provider',
    );

    const proofResult = await provider.send('eth_getProof', [
      dispatchedHookAddress,
      [storageSlot],
      blockTag,
    ]);

    if (!proofResult || !proofResult.accountProof) {
      throw new Error(
        `eth_getProof returned invalid response for ${dispatchedHookAddress}`,
      );
    }

    const accountProof: string[] = proofResult.accountProof;
    const storageProof: string[] = proofResult.storageProof?.[0]?.proof || [];

    const metadata = encodeCosmWasmTelepathyMetadata(
      slot,
      accountProof,
      storageProof,
    );
    logger?.info(
      { metadataLength: metadata.length },
      'Successfully encoded CosmWasm metadata',
    );

    return metadata;
  }
}
