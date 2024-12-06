// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

import {IMailbox} from "../../interfaces/IMailbox.sol";

import {Message} from "../../libs/Message.sol";

import {RLPReader} from "fx-portal/contracts/lib/RLPReader.sol";
import {RLPEncode} from "../libs/RLPEncode.sol";

import {MerklePatriciaProof} from "fx-portal/contracts/lib/MerklePatriciaProof.sol";

interface IBlockHashOracle {
    function origin() external view returns (uint32);
    function blockHash(uint256 height) external view returns (uint256 hash);
}

struct BlockHashMessageProof {
    bytes rlpBlockHeader;
    bytes rlpTxReceipt;
    bytes txReceiptProof;
    uint256 txIndex;
    uint256 blockHeight;
}

contract BlockHashIsm {
    using RLPReader for RLPReader.RLPItem;
    using RLPReader for bytes;

    bytes32 internal constant DISPATCH_EVENT_SIGNATURE = keccak256("Dispatch(address,uint32,bytes32,bytes)"); // the event we are looking for
    address public immutable MAILBOX; // the event originator we expect
    uint32 public immutable ORIGIN; // caching the origin chain of the oracle for gas efficiency. I assume that origin does not change.
    IBlockHashOracle public oracle;

    constructor(IBlockHashOracle _oracle, address _mailbox) {
        oracle = _oracle;
        MAILBOX = _mailbox;
        ORIGIN = _oracle.origin();
    }

    function verify(bytes calldata proof, bytes calldata message) external view returns (bool) {
        BlockHashMessageProof memory blockHashProof = abi.decode(proof, (BlockHashMessageProof));

        return verify_internal(blockHashProof, message);
    }

    // if a message was dispatched, that means there was an event emitted with the message.
    // strategy: using a block hash available through the oracle, the caller must provide a proof that the dispatch emit was emitted in that block.
    // an efficient approach might try to use the block's event bloom filter.
    // However, I avoid this because of the chance of false positives.
    // This can be taken advantage of by attackers by finding events that populate the desired bits in a bloom filter.
    function verify_internal(BlockHashMessageProof memory proof, bytes calldata message) internal view returns (bool) {
        bytes32 blockHash = keccak256(proof.rlpBlockHeader);

        // Verify that the block header provided is a block hash available from the oracle.
        if (oracle.blockHash(proof.blockHeight) != uint256(blockHash)) return false;
        // Verify that the origin of the message is the oracles' origin.
        if (Message.origin(message) != ORIGIN) return false;

        // Verify that the given tx receipt is included in the block header
        if (
            !MerklePatriciaProof.verify(
                proof.rlpTxReceipt,
                RLPEncode.encodeUint(proof.txIndex),
                proof.txReceiptProof,
                getReceiptRoot(proof.rlpBlockHeader)
            )
        ) return false;

        // Verify that a dispatch event log with the given message was included in the tx receipt
        if (!verifyMessageInReceipt(proof.rlpTxReceipt, message)) return false;

        return true;
    }

    function getReceiptRoot(bytes memory rlpBlockHeader) internal pure returns (bytes32) {
        RLPReader.RLPItem[] memory items = rlpBlockHeader.toRlpItem().toList();
        return bytes32(items[5].toBytes());
    }

    function verifyMessageInReceipt(bytes memory rlpTxReceipt, bytes calldata message) internal view returns (bool) {
        RLPReader.RLPItem[] memory logs = rlpTxReceipt.toRlpItem().toList()[3].toList();

        // If we knew deterministically what log index the event would be, we could save gas by not iterating through all logs. I do not assume this here.
        for (uint256 i; i < logs.length; i++) {
            RLPReader.RLPItem[] memory logEntry = logs[i].toList();

            // check emitter
            if (address(uint160(logEntry[0].toAddress())) == MAILBOX) {
                // check topics
                RLPReader.RLPItem[] memory topics = logEntry[1].toList();
                if (
                    topics.length == 4 && bytes32(topics[0].toUint()) == DISPATCH_EVENT_SIGNATURE
                        && address(uint160(topics[1].toAddress())) == Message.senderAddress(message)
                        && uint32(topics[2].toUint()) == Message.destination(message)
                        && bytes32(topics[3].toUint()) == Message.recipient(message)
                        && keccak256(logEntry[2].toBytes()) == keccak256(message) // data field
                ) return true;
            }
        }

        return false;
    }
}
