import { BN } from 'bn.js';
import rlp from 'rlp';
import Web3 from 'web3';

const web3 = new Web3('https://eth.llamarpc.com');
const blockNumber = 18000000;

const toBuffer = (value) => {
  if (value == null) return Buffer.alloc(0);
  if (BN.isBN(value)) return value.toArrayLike(Buffer);
  if (typeof value === 'number' || typeof value === 'bigint')
    return new BN(value).toArrayLike(Buffer);
  if (typeof value === 'string' && value.startsWith('0x')) {
    const hex = value.slice(2).padStart(value.length % 2 === 0 ? 0 : 1, '0');
    return Buffer.from(hex, 'hex');
  }
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  throw new Error(`Unsupported type for RLP encoding: ${typeof value}`);
};

async function main() {
  const block = await web3.eth.getBlock(blockNumber, false);

  const rawFields = [
    block.parentHash,
    block.sha3Uncles,
    block.miner,
    block.stateRoot,
    block.transactionsRoot,
    block.receiptsRoot,
    block.logsBloom,
    block.difficulty,
    block.number,
    block.gasLimit,
    block.gasUsed,
    block.timestamp,
    block.extraData,
    block.mixHash,
    block.nonce,
    block.baseFeePerGas ?? Buffer.alloc(0),
  ];

  const fields = rawFields.map((field, index) =>
    // Numeric fields are at positions 7–11 and 15 (difficulty, number, gasLimit, gasUsed, timestamp, baseFeePerGas).
    [7, 8, 9, 10, 11, 15].includes(index)
      ? new BN(field).toArrayLike(Buffer)
      : toBuffer(field),
  );

  const encodedHeader = Buffer.from(rlp.encode(fields));
  const headerHash = web3.utils.keccak256(encodedHeader);

  console.log('Block number    :', block.number);
  console.log('Expected hash   :', block.hash);
  console.log('RLP header hash :', headerHash);
  console.log('RLP encoded     :', '0x' + encodedHeader.toString('hex'));
}

main().catch(console.error);
