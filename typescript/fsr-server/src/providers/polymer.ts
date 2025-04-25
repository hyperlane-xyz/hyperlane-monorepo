import { z } from 'zod';

import { FSRResponse } from '../index.js';

// Provider type constant
export const POLYMER_PROVIDER_TYPE = 'Polymer';

// Magic number prefix for directive messages
const MAGIC_NUMBER =
  '0xFAF09B8DEEC3D47AB5A2F9007ED1C8AD83E602B7FDAA1C47589F370CDA6BF2E1';

// Directive types
// NB: We may want to make directive types common across all providers.
enum DirectiveType {
  EVMLog = 0x01,
}

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
          return {
            // TODO: Need to parse the log from the proof.
            result: directiveHex,
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
