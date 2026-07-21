// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IBlockHashOracle} from "../../interfaces/IBlockHashOracle.sol";
import {Message} from "../../libs/Message.sol";
import {RLPReader} from "../../libs/RLPReader.sol";
import {MerklePatriciaTrie} from "../../libs/MerklePatriciaTrie.sol";
import {BlockHashIsmMetadata} from "../libs/BlockHashIsmMetadata.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title BlockHashIsm
 * @notice ISM that verifies messages using block hash oracle and receipt proofs
 * @dev Verifies that a Dispatch event was emitted by the origin Mailbox
 *      by proving inclusion in the receiptsRoot of a block whose hash
 *      is attested to by the oracle.
 */
contract BlockHashIsm is IInterchainSecurityModule, PackageVersioned {
    using Message for bytes;
    using BlockHashIsmMetadata for bytes;
    using RLPReader for bytes;

    // ============ Constants ============

    /// @notice Module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    /// @notice DispatchId event signature: keccak256("DispatchId(bytes32)")
    bytes32 public constant DISPATCH_ID_TOPIC =
        0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a;

    // ============ Immutables ============

    /// @notice The block hash oracle for the origin chain
    IBlockHashOracle public immutable oracle;

    /// @notice The Mailbox address on the origin chain
    address public immutable originMailbox;

    /// @notice The origin domain ID (cached from oracle)
    uint32 public immutable origin;

    // ============ Constructor ============

    /**
     * @param _oracle The block hash oracle for the origin chain
     * @param _originMailbox The Mailbox address on the origin chain
     */
    constructor(IBlockHashOracle _oracle, address _originMailbox) {
        require(address(_oracle) != address(0), "BlockHashIsm: zero oracle");
        require(_originMailbox != address(0), "BlockHashIsm: zero mailbox");

        oracle = _oracle;
        originMailbox = _originMailbox;
        origin = _oracle.origin();
    }

    // ============ External Functions ============

    /**
     * @notice Verifies that a message was dispatched on the origin chain
     * @param _metadata Encoded proof data (see BlockHashIsmMetadata)
     * @param _message Hyperlane formatted message
     * @return True if verification succeeds
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view returns (bool) {
        require(_message.origin() == origin, "BlockHashIsm: wrong origin");

        bytes32 receiptsRoot = _verifyBlockHeader(_metadata);

        (address emitter, bytes32 logMessageId) = _verifyReceiptProof(
            _metadata,
            receiptsRoot
        );

        require(emitter == originMailbox, "BlockHashIsm: wrong emitter");
        require(
            logMessageId == _message.id(),
            "BlockHashIsm: message ID mismatch"
        );

        return true;
    }

    // ============ Internal Functions ============

    /**
     * @notice Verifies block header against oracle and extracts receiptsRoot
     * @param _metadata The metadata containing block header
     * @return receiptsRoot The receipts root from the verified header
     */
    function _verifyBlockHeader(
        bytes calldata _metadata
    ) internal view returns (bytes32 receiptsRoot) {
        uint64 blockNum = _metadata.blockNumber();
        bytes32 expectedBlockHash = oracle.blockHash(blockNum);
        require(
            expectedBlockHash != bytes32(0),
            "BlockHashIsm: block not found"
        );

        bytes calldata header = _metadata.blockHeader();
        require(
            keccak256(header) == expectedBlockHash,
            "BlockHashIsm: invalid block header"
        );

        receiptsRoot = header.extractReceiptsRoot();
    }

    /**
     * @notice Verifies receipt proof and extracts DispatchId log
     * @param _metadata The metadata containing proof
     * @param _receiptsRoot The verified receipts root
     * @return emitter The log emitter address
     * @return messageId The message ID from the log
     */
    function _verifyReceiptProof(
        bytes calldata _metadata,
        bytes32 _receiptsRoot
    ) internal pure returns (address emitter, bytes32 messageId) {
        bytes memory txKey = BlockHashIsmMetadata.encodeTxIndexAsKey(
            _metadata.txIndex()
        );

        bytes[] memory proof = _metadata.proofNodes();
        bytes memory receiptRlp = MerklePatriciaTrie.verifyProof(
            _receiptsRoot,
            txKey,
            proof
        );

        return _parseReceiptForDispatchId(receiptRlp, _metadata.logIndex());
    }

    /**
     * @notice Parses a receipt to extract DispatchId log data
     * @param _receiptRlp RLP encoded receipt
     * @param _logIndex Index of the log to extract
     * @return emitter The log emitter address
     * @return messageId The message ID from the log
     */
    function _parseReceiptForDispatchId(
        bytes memory _receiptRlp,
        uint8 _logIndex
    ) internal pure returns (address emitter, bytes32 messageId) {
        bytes memory receiptData = _receiptRlp;

        // Handle typed transaction receipts (EIP-2718)
        if (_receiptRlp.length > 0) {
            uint8 firstByte = uint8(_receiptRlp[0]);
            if (firstByte == 0x01 || firstByte == 0x02) {
                receiptData = _slice(_receiptRlp, 1, _receiptRlp.length - 1);
            }
        }

        bytes[] memory receiptItems = RLPReader.decodeList(receiptData);
        require(receiptItems.length >= 4, "BlockHashIsm: invalid receipt");

        bytes[] memory logs = RLPReader.decodeList(receiptItems[3]);
        require(_logIndex < logs.length, "BlockHashIsm: log index OOB");

        bytes[] memory logItems = RLPReader.decodeList(logs[_logIndex]);
        require(logItems.length >= 3, "BlockHashIsm: invalid log");

        emitter = RLPReader.toAddress(logItems[0]);

        bytes[] memory topics = RLPReader.decodeList(logItems[1]);
        require(topics.length >= 2, "BlockHashIsm: missing topics");

        bytes32 eventSig = bytes32(RLPReader.toBytes(topics[0]));
        require(
            eventSig == DISPATCH_ID_TOPIC,
            "BlockHashIsm: wrong event signature"
        );

        messageId = bytes32(RLPReader.toBytes(topics[1]));
    }

    /**
     * @notice Slices bytes from memory
     */
    function _slice(
        bytes memory _data,
        uint256 _start,
        uint256 _length
    ) internal pure returns (bytes memory result) {
        result = new bytes(_length);
        for (uint256 i = 0; i < _length; i++) {
            result[i] = _data[_start + i];
        }
    }
}
