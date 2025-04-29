import { utils } from 'ethers';
import { z } from 'zod';

import { EvmLog, encodeEvmLog } from '../directives/evm_log.js';
import { DirectiveType, MAGIC_NUMBER } from '../directives/types.js';
import { FSRResponse } from '../index.js';

/**
 * Schema for Polymer directive
 * Format: [MAGIC_NUMBER,[DIRECTIVE_TYPE,[CHAIN_ID,BLOCK_NUMBER,TX_INDEX,LOG_INDEX]]
 *
 * Byte layout:
 * - MAGIC_NUMBER (32 bytes)
 * - DIRECTIVE_TYPE (1 byte)
 * - CHAIN_ID (8 bytes, u64)
 * - BLOCK_NUMBER (8 bytes, u64)
 * - TX_INDEX (4 bytes, u32)
 * - LOG_INDEX (4 bytes, u32)
 */
const PolymerDirectiveSchema = z.object({
  chainId: z.number(),
  blockNumber: z.number(),
  txIndex: z.number(),
  logIndex: z.number(),
});

type PolymerDirective = z.infer<typeof PolymerDirectiveSchema>;

export class PolymerProvider {
  private apiToken: string;
  private apiEndpoint: string;
  private maxRetries: number;

  constructor(apiToken: string, apiEndpoint: string, maxRetries: number = 5) {
    this.apiToken = apiToken;
    this.apiEndpoint = apiEndpoint;
    this.maxRetries = maxRetries;
  }

  async process(directiveHex: string): Promise<FSRResponse> {
    try {
      // Parse the directive hex string into a PolymerDirective
      const directive = this.parseDirective(directiveHex);

      // Create the proof request
      const request = {
        jsonrpc: '2.0',
        id: 1,
        method: 'log_requestProof',
        params: [
          directive.chainId,
          directive.blockNumber,
          directive.txIndex,
          directive.logIndex,
        ],
      };

      // Request the proof
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify(request),
      });

      const { result: jobId } = await response.json();

      // Poll for the proof
      let attempts = 0;
      while (attempts < this.maxRetries) {
        const pollResponse = await fetch(this.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'log_queryProof',
            params: [jobId],
          }),
        });

        const { result } = await pollResponse.json();

        if (result.status === 'ready' || result.status === 'complete') {
          // Parse the proof and encode it as an EvmLogDirective
          const encodedDirective = this.parseProof(result.proof);

          return {
            result: encodedDirective,
            proof: result.proof,
          };
        }

        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
      }

      throw new Error('Timeout waiting for proof');
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to process Polymer directive: ${error.message}`,
        );
      }
      throw new Error('Failed to process Polymer directive: Unknown error');
    }
  }

  /**
   * Proof byte layout
   *  *--------------------------------------------------*
   *  |  state root (32 bytes)                           | 0:32
   *  *--------------------------------------------------*
   *  |  signature (65 bytes)                            | 32:97
   *  *--------------------------------------------------*
   *  |  source chain ID (big endian, 4 bytes)           | 97:101
   *  *--------------------------------------------------*
   *  |  peptide height (big endian, 8 bytes)            | 101:109
   *  *--------------------------------------------------*
   *  |  source chain block height (big endian, 8 bytes) | 109:117
   *  *--------------------------------------------------*
   *  |  receipt index (big endian, 2 bytes)             | 117:119
   *  *--------------------------------------------------*
   *  |  event index (1 byte)                            | 119
   *  *--------------------------------------------------*
   *  |  number of topics (1 byte)                       | 120
   *  *--------------------------------------------------*
   *  |  event data end (big endian, 2 bytes)            | 121:123
   *  *--------------------------------------------------*
   *  |  event emitter (contract address) (20 bytes)     | 123:143
   *  *--------------------------------------------------*
   *  |  topics (32 bytes * number of topics)            | 143 + 32 * number of topics: eventDatEnd
   *  *--------------------------------------------------*
   *  |  event data (x bytes)                            | eventDataEnd:
   *  *--------------------------------------------------*
   *  |  iavl proof (x bytes)                            |
   *  *--------------------------------------------------*
   */
  private parseProof(proofHex: string): string {
    // Remove '0x' prefix if present
    const hex = proofHex.startsWith('0x') ? proofHex.slice(2) : proofHex;
    const bytes = Buffer.from(hex, 'hex');

    // Parse source chain ID (4 bytes, big endian)
    const sourceChainId = bytes.readUInt32BE(97).toString();

    // Parse event emitter (20 bytes)
    const eventEmitter = '0x' + bytes.subarray(123, 143).toString('hex');

    // Parse number of topics (1 byte)
    const numTopics = bytes[120];

    // Parse topics (32 bytes each)
    const topics: string[] = [];
    let offset = 143;
    for (let i = 0; i < numTopics; i++) {
      const topic = '0x' + bytes.subarray(offset, offset + 32).toString('hex');
      topics.push(topic);
      offset += 32;
    }

    // Parse event data end (2 bytes, big endian)
    const eventDataEnd = bytes.readUInt16BE(121);

    // Parse event data (from eventDataEnd to the end of the proof)
    const eventData = '0x' + bytes.subarray(eventDataEnd).toString('hex');

    // Create EvmLog
    const log: EvmLog = {
      chainId: sourceChainId,
      contract: eventEmitter,
      indexed: topics,
      unindexed: eventData,
    };

    // Encode the evm log
    return encodeEvmLog(log);
  }

  private parseDirective(directiveHex: string): PolymerDirective {
    // Remove '0x' prefix if present
    const hex = directiveHex.startsWith('0x')
      ? directiveHex.slice(2)
      : directiveHex;

    // Convert hex to bytes
    const bytes = Buffer.from(hex, 'hex');

    // Check magic number
    const magicNumberBytes = Buffer.from(MAGIC_NUMBER.slice(2), 'hex');
    if (bytes.length < magicNumberBytes.length + 1 || bytes[0] !== 0x5b) {
      // '['
      throw new Error('Invalid directive format: missing opening bracket');
    }

    if (
      bytes.subarray(1, magicNumberBytes.length + 1).toString('hex') !==
      magicNumberBytes.toString('hex')
    ) {
      throw new Error('Invalid magic number');
    }

    // Skip magic number and opening brackets
    let offset = magicNumberBytes.length + 2; // +2 for '[' and ','

    // Check directive type
    const directiveType = bytes[offset];
    if (directiveType !== DirectiveType.EVMLog) {
      throw new Error('Unsupported directive type');
    }
    offset += 2; // Skip directive type and comma

    // Check for opening bracket of args
    if (bytes[offset] !== 0x5b) {
      // '['
      throw new Error('Invalid args format');
    }
    offset += 1;

    // Parse args (chain_id, block_number, tx_index, log_index)
    const chainId = bytes.readBigUInt64BE(offset);
    offset += 8;
    const blockNumber = bytes.readBigUInt64BE(offset);
    offset += 8;
    const txIndex = bytes.readUInt32BE(offset);
    offset += 4;
    const logIndex = bytes.readUInt32BE(offset);

    return {
      chainId: Number(chainId),
      blockNumber: Number(blockNumber),
      txIndex,
      logIndex,
    };
  }
}
