// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {BlockHashIsm} from "../../contracts/isms/blockhash/BlockHashIsm.sol";
import {IBlockHashOracle} from "../../contracts/interfaces/IBlockHashOracle.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {RLPReader} from "../../contracts/libs/RLPReader.sol";
import {MerklePatriciaTrie} from "../../contracts/libs/MerklePatriciaTrie.sol";
import {BlockHashIsmMetadata} from "../../contracts/isms/libs/BlockHashIsmMetadata.sol";

contract MockBlockHashOracle is IBlockHashOracle {
    uint32 public immutable origin;
    mapping(uint256 => bytes32) public blockHashes;

    constructor(uint32 _origin) {
        origin = _origin;
    }

    function setBlockHash(uint256 _height, bytes32 _hash) external {
        blockHashes[_height] = _hash;
    }

    function blockHash(uint256 _height) external view returns (bytes32) {
        return blockHashes[_height];
    }
}

// Test harness to wrap calldata functions
contract MetadataHarness {
    function blockNumber(bytes calldata _metadata) external pure returns (uint64) {
        return BlockHashIsmMetadata.blockNumber(_metadata);
    }

    function txIndex(bytes calldata _metadata) external pure returns (uint16) {
        return BlockHashIsmMetadata.txIndex(_metadata);
    }

    function logIndex(bytes calldata _metadata) external pure returns (uint8) {
        return BlockHashIsmMetadata.logIndex(_metadata);
    }

    function proofNodes(bytes calldata _metadata) external pure returns (bytes[] memory) {
        return BlockHashIsmMetadata.proofNodes(_metadata);
    }
}

contract RLPHarness {
    function extractReceiptsRoot(bytes calldata _header) external pure returns (bytes32) {
        return RLPReader.extractReceiptsRoot(_header);
    }
}

// Wrapper to convert memory to calldata for Message.formatMessage
contract MessageHarness {
    function formatMessage(
        uint8 _version,
        uint32 _nonce,
        uint32 _originDomain,
        bytes32 _sender,
        uint32 _destinationDomain,
        bytes32 _recipient,
        bytes calldata _messageBody
    ) external pure returns (bytes memory) {
        return Message.formatMessage(
            _version,
            _nonce,
            _originDomain,
            _sender,
            _destinationDomain,
            _recipient,
            _messageBody
        );
    }
}

contract BlockHashIsmTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    BlockHashIsm public ism;
    MockBlockHashOracle public oracle;
    MetadataHarness public metadataHarness;
    RLPHarness public rlpHarness;
    MessageHarness public messageHarness;

    uint32 constant ORIGIN_DOMAIN = 1;
    uint32 constant DEST_DOMAIN = 2;
    address constant ORIGIN_MAILBOX = address(0x1234567890123456789012345678901234567890);
    address constant SENDER = address(0x5eeD5EED5eeD5EEd5eed5eEd5eEd5eed5EeD5EEd);
    address constant RECIPIENT = address(0xBEeFbeefbEefbeEFbeEfbEEfBEeFbeEfBeEfBeef);

    function setUp() public {
        oracle = new MockBlockHashOracle(ORIGIN_DOMAIN);
        ism = new BlockHashIsm(oracle, ORIGIN_MAILBOX);
        metadataHarness = new MetadataHarness();
        rlpHarness = new RLPHarness();
        messageHarness = new MessageHarness();
    }

    // ============ Constructor Tests ============

    function test_constructor_setsImmutables() public view {
        assertEq(address(ism.oracle()), address(oracle));
        assertEq(ism.originMailbox(), ORIGIN_MAILBOX);
        assertEq(ism.origin(), ORIGIN_DOMAIN);
    }

    function test_constructor_revertsOnZeroOracle() public {
        vm.expectRevert("BlockHashIsm: zero oracle");
        new BlockHashIsm(IBlockHashOracle(address(0)), ORIGIN_MAILBOX);
    }

    function test_constructor_revertsOnZeroMailbox() public {
        vm.expectRevert("BlockHashIsm: zero mailbox");
        new BlockHashIsm(oracle, address(0));
    }

    function test_moduleType() public view {
        assertEq(ism.moduleType(), uint8(IInterchainSecurityModule.Types.NULL));
    }

    // ============ Origin Check Tests ============

    function test_verify_revertsOnWrongOrigin() public {
        bytes memory message = _createMessage(DEST_DOMAIN); // Wrong origin
        bytes memory metadata = _createEmptyMetadata();

        vm.expectRevert("BlockHashIsm: wrong origin");
        ism.verify(metadata, message);
    }

    // ============ Block Hash Tests ============

    function test_verify_revertsOnBlockNotFound() public {
        bytes memory message = _createMessage(ORIGIN_DOMAIN);
        bytes memory metadata = _createMetadataWithBlockNumber(12345);

        // Oracle returns 0 (block not found)
        vm.expectRevert("BlockHashIsm: block not found");
        ism.verify(metadata, message);
    }

    function test_verify_revertsOnInvalidBlockHeader() public {
        bytes memory message = _createMessage(ORIGIN_DOMAIN);

        // Set a block hash in oracle
        uint64 blockNum = 12345;
        bytes32 fakeBlockHash = keccak256("fake block");
        oracle.setBlockHash(blockNum, fakeBlockHash);

        // Create metadata with invalid header (won't hash to fakeBlockHash)
        bytes memory metadata = _createMetadataWithHeader(blockNum, hex"c0"); // Empty RLP list

        vm.expectRevert("BlockHashIsm: invalid block header");
        ism.verify(metadata, message);
    }

    // ============ RLP Reader Unit Tests ============

    function test_rlpReader_decodeShortString() public pure {
        // "dog" = 0x83 'd' 'o' 'g'
        bytes memory data = hex"83646f67";
        bytes memory decoded = RLPReader.toBytes(data);
        assertEq(decoded, bytes("dog"));
    }

    function test_rlpReader_decodeEmptyString() public pure {
        bytes memory data = hex"80";
        bytes memory decoded = RLPReader.toBytes(data);
        assertEq(decoded.length, 0);
    }

    function test_rlpReader_decodeSingleByte() public pure {
        bytes memory data = hex"61"; // 'a'
        bytes memory decoded = RLPReader.toBytes(data);
        assertEq(decoded, bytes("a"));
    }

    function test_rlpReader_decodeList() public pure {
        // ["cat", "dog"] = 0xc8 0x83 'c' 'a' 't' 0x83 'd' 'o' 'g'
        bytes memory data = hex"c88363617483646f67";
        bytes[] memory items = RLPReader.decodeList(data);
        assertEq(items.length, 2);
    }

    // ============ Metadata Encoding Tests ============

    function test_metadata_blockNumber() public view {
        bytes memory metadata = _createMetadataWithBlockNumber(0x123456789ABCDEF0);
        assertEq(metadataHarness.blockNumber(metadata), 0x123456789ABCDEF0);
    }

    function test_metadata_txIndexEncoding() public pure {
        // 0 encodes as 0x80
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(0), hex"80");

        // 1-127 encode as single byte
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(1), hex"01");
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(127), hex"7f");

        // 128-255 encode as 0x81 + byte
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(128), hex"8180");
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(255), hex"81ff");

        // 256+ encode as 0x82 + 2 bytes
        assertEq(BlockHashIsmMetadata.encodeTxIndexAsKey(256), hex"820100");
    }

    // ============ DISPATCH_ID_TOPIC Tests ============

    function test_dispatchIdTopic() public view {
        bytes32 expected = keccak256("DispatchId(bytes32)");
        assertEq(ism.DISPATCH_ID_TOPIC(), expected);
    }

    // ============ MPT Proof Tests ============

    function test_mpt_singleLeafProof() public pure {
        // Construct a simple trie with one leaf node
        // Key: empty, Value: "test" (RLP encoded in the node)
        bytes memory valueRlp = hex"8474657374"; // RLP of "test"

        // Leaf node: [0x20 prefix (leaf, even, empty remaining path), value]
        // HP encoding: 0x20 = leaf flag (0x2_) + even flag (_0) + no nibbles
        bytes memory leafNode = _rlpEncodeList2(hex"20", valueRlp);

        bytes32 root = keccak256(leafNode);
        bytes[] memory proof = new bytes[](1);
        proof[0] = leafNode;

        // Empty key → nibbles is empty → should match leaf with empty path
        // MPT returns the RLP-decoded value
        bytes memory result = MerklePatriciaTrie.verifyProof(root, hex"", proof);
        assertEq(result, bytes("test"));
    }

    function test_mpt_revertsOnEmptyProof() public {
        bytes[] memory emptyProof = new bytes[](0);

        vm.expectRevert("MPT: empty proof");
        MerklePatriciaTrie.verifyProof(bytes32(0), hex"00", emptyProof);
    }

    function test_mpt_revertsOnHashMismatch() public {
        bytes memory leafNode = hex"c28020"; // Simple leaf
        bytes32 wrongRoot = keccak256("wrong");

        bytes[] memory proof = new bytes[](1);
        proof[0] = leafNode;

        vm.expectRevert("MPT: invalid proof node hash");
        MerklePatriciaTrie.verifyProof(wrongRoot, hex"80", proof);
    }

    // ============ Receipt Parsing Tests ============

    function test_rlpReader_extractReceiptsRoot() public view {
        // Minimal block header with 6 items, receiptsRoot at index 5
        bytes32 expectedRoot = keccak256("receiptsRoot");
        bytes memory rootRlp = abi.encodePacked(uint8(0xa0), expectedRoot); // 0xa0 = 32-byte string

        // Build header: [item0, item1, item2, item3, item4, receiptsRoot]
        bytes memory header = _buildMinimalHeader(rootRlp);

        bytes32 extracted = rlpHarness.extractReceiptsRoot(header);
        assertEq(extracted, expectedRoot);
    }

    function test_rlpReader_toAddress() public pure {
        address expected = address(0x1234567890123456789012345678901234567890);
        // RLP encode: 0x94 + 20 bytes (0x94 = 0x80 + 20)
        bytes memory rlpAddr = abi.encodePacked(uint8(0x94), expected);

        address decoded = RLPReader.toAddress(rlpAddr);
        assertEq(decoded, expected);
    }

    function test_rlpReader_revertsOnInvalidAddressLength() public {
        // 19 bytes instead of 20 (0x93 = 0x80 + 19, then 19 bytes of data)
        bytes memory badAddr = hex"9312345678901234567890123456789012345678"; // 0x93 + 19 bytes

        vm.expectRevert("RLP: invalid address length");
        RLPReader.toAddress(badAddr);
    }

    // ============ Metadata Proof Parsing Tests ============

    function test_metadata_proofNodes() public view {
        bytes memory node1 = hex"aabbcc";
        bytes memory node2 = hex"ddeeff0011";

        bytes memory proofData = abi.encodePacked(
            uint16(node1.length), node1,
            uint16(node2.length), node2
        );

        bytes memory metadata = abi.encodePacked(
            uint64(1),           // block number
            uint16(1),           // header length
            hex"c0",             // minimal header
            uint16(0),           // tx index
            uint8(0),            // log index
            proofData            // proof nodes
        );

        bytes[] memory nodes = metadataHarness.proofNodes(metadata);
        assertEq(nodes.length, 2);
        assertEq(nodes[0], node1);
        assertEq(nodes[1], node2);
    }

    function test_metadata_emptyProofNodes() public view {
        bytes memory metadata = abi.encodePacked(
            uint64(1),
            uint16(1),
            hex"c0",
            uint16(0),
            uint8(0)
            // no proof nodes
        );

        bytes[] memory nodes = metadataHarness.proofNodes(metadata);
        assertEq(nodes.length, 0);
    }

    // ============ Helper Functions ============

    function _rlpEncodeList2(bytes memory a, bytes memory b) internal pure returns (bytes memory) {
        uint256 totalLen = a.length + b.length;
        if (totalLen < 56) {
            return abi.encodePacked(uint8(0xc0 + totalLen), a, b);
        }
        revert("List too long for test helper");
    }

    function _buildMinimalHeader(bytes memory receiptsRoot) internal pure returns (bytes memory) {
        // 6 empty items + receiptsRoot at index 5
        bytes memory empty = hex"80"; // RLP empty string
        bytes memory items = abi.encodePacked(
            empty, empty, empty, empty, empty, receiptsRoot
        );
        uint256 len = items.length;
        if (len < 56) {
            return abi.encodePacked(uint8(0xc0 + len), items);
        }
        // Long list encoding
        return abi.encodePacked(uint8(0xf7 + 1), uint8(len), items);
    }

    function _createMessage(uint32 _origin) internal view returns (bytes memory) {
        return messageHarness.formatMessage(
            uint8(3), // version
            uint32(1), // nonce
            _origin,
            TypeCasts.addressToBytes32(SENDER),
            DEST_DOMAIN,
            TypeCasts.addressToBytes32(RECIPIENT),
            hex"74657374206d65737361676520626f6479" // "test message body"
        );
    }

    function _createEmptyMetadata() internal pure returns (bytes memory) {
        return _createMetadataWithBlockNumber(0);
    }

    function _createMetadataWithBlockNumber(
        uint64 _blockNum
    ) internal pure returns (bytes memory) {
        // Minimal metadata: blockNumber (8) + headerLen (2) + header (0) + txIndex (2) + logIndex (1)
        return abi.encodePacked(
            _blockNum,      // 8 bytes
            uint16(0),      // header length
            uint16(0),      // tx index
            uint8(0)        // log index
        );
    }

    function _createMetadataWithHeader(
        uint64 _blockNum,
        bytes memory _header
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            _blockNum,
            uint16(_header.length),
            _header,
            uint16(0),      // tx index
            uint8(0)        // log index
        );
    }
}

// ============ Fuzz Tests ============

contract BlockHashIsmFuzzTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    MockBlockHashOracle public oracle;
    BlockHashIsm public ism;
    MetadataHarness public metadataHarness;

    uint32 constant ORIGIN_DOMAIN = 1;
    address constant ORIGIN_MAILBOX = address(0x1234567890123456789012345678901234567890);

    function setUp() public {
        oracle = new MockBlockHashOracle(ORIGIN_DOMAIN);
        ism = new BlockHashIsm(oracle, ORIGIN_MAILBOX);
        metadataHarness = new MetadataHarness();
    }

    function testFuzz_verify_alwaysRevertsOnWrongOrigin(
        uint32 _wrongOrigin,
        uint32 _nonce,
        bytes32 _sender,
        bytes32 _recipient,
        bytes calldata _body
    ) public {
        vm.assume(_wrongOrigin != ORIGIN_DOMAIN);
        vm.assume(_body.length < 1000); // Reasonable size

        bytes memory message = Message.formatMessage(
            uint8(3),
            _nonce,
            _wrongOrigin,
            _sender,
            uint32(2),
            _recipient,
            _body
        );

        bytes memory metadata = abi.encodePacked(
            uint64(1),
            uint16(0),
            uint16(0),
            uint8(0)
        );

        vm.expectRevert("BlockHashIsm: wrong origin");
        ism.verify(metadata, message);
    }

    function testFuzz_metadata_blockNumber(uint64 _blockNum) public view {
        bytes memory metadata = abi.encodePacked(
            _blockNum,
            uint16(0),
            uint16(0),
            uint8(0)
        );

        assertEq(metadataHarness.blockNumber(metadata), _blockNum);
    }

    function testFuzz_metadata_txIndex(uint16 _txIndex) public view {
        bytes memory header = hex"c0"; // Empty RLP list
        bytes memory metadata = abi.encodePacked(
            uint64(1),
            uint16(header.length),
            header,
            _txIndex,
            uint8(0)
        );

        assertEq(metadataHarness.txIndex(metadata), _txIndex);
    }

    function testFuzz_metadata_logIndex(uint8 _logIndex) public view {
        bytes memory header = hex"c0";
        bytes memory metadata = abi.encodePacked(
            uint64(1),
            uint16(header.length),
            header,
            uint16(0),
            _logIndex
        );

        assertEq(metadataHarness.logIndex(metadata), _logIndex);
    }
}
