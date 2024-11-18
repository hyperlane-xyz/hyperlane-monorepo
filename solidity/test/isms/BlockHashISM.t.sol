// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {BlockHashISM, IBlockHashOracle} from "../../contracts/isms/BlockHashISM.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

contract BlockHashISMTest is Test {
    using TypeCasts for address;

    BlockHashISM public blockHashISM;
    MockBlockHashOracle public oracle;

    uint256 constant testBlockHash = uint256(keccak256("test_block_hash"));
    uint256 constant testBlockHeight = 123456;

    function setUp() public {
        // Deploy the mock oracle
        oracle = new MockBlockHashOracle();

        // Set the oracle to return testBlockHash for testBlockHeight
        oracle.setBlockHash(testBlockHeight, testBlockHash);

        // Deploy the BlockHashISM contract with the mock oracle
        blockHashISM = new BlockHashISM(address(oracle));
    }

    function testVerifyValidMessage() public {
        // Encode the message body with the correct block hash and block height
        bytes memory message = _encodeMessage(
            testBlockHash,
            testBlockHeight,
            false
        );

        // Call verify with the correctly encoded message
        bool result = blockHashISM.verify("", message);

        // Assert that verification succeeds
        assertTrue(
            result,
            "Verification should succeed for correct block hash and height"
        );
    }

    function testVerifyInvalidBlockHash() public {
        // Encode the message body with an incorrect block hash but the correct block height
        bytes memory message = _encodeMessage(
            uint256(0),
            testBlockHeight,
            false
        );

        // Expect the verify function to revert due to incorrect block hash
        vm.expectRevert("Transaction not dispatched from origin chain");
        blockHashISM.verify("", message);
    }

    function testVerifyInvalidBlockHeight() public {
        // Encode the message body with the correct block hash but an incorrect block height
        bytes memory message = _encodeMessage(
            testBlockHash,
            testBlockHeight + 1,
            false
        );

        // Expect the verify function to revert due to incorrect block height
        vm.expectRevert("Transaction not dispatched from origin chain");
        blockHashISM.verify("", message);
    }

    function testVerifyInvalidMessageBodyLength() public {
        // Encode the message body with insufficient length
        bytes memory message = _encodeMessage(0, 0, true);

        // Expect the _extractBlockInfo function to revert due to invalid message length
        vm.expectRevert("Invalid message body");
        blockHashISM.verify("", message);
    }

    // ============ Helper Functions ============
    function _encodeMessage(
        uint256 _hash,
        uint256 _height,
        bool invalidBody
    ) internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                uint8(0),
                uint32(1),
                1,
                address(0x1).addressToBytes32(),
                2,
                address(0x1).addressToBytes32(),
                !invalidBody
                    ? abi.encode(_hash, _height, "Hello World")
                    : abi.encodePacked("")
            );
    }
}

/// @dev Mock implementation of IBlockHashOracle for testing purposes
contract MockBlockHashOracle is IBlockHashOracle {
    uint32 public override origin = 1;
    mapping(uint256 => uint256) private blockHashes;

    function setBlockHash(uint256 height, uint256 hash) public {
        blockHashes[height] = hash;
    }

    function blockHash(
        uint256 height
    ) external view override returns (uint256) {
        return blockHashes[height];
    }
}
//TODO check if mocks go somewhere
