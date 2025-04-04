// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "../../contracts/mock/MockBlockHashOracle.sol";
import "../../lib/forge-std/src/Test.sol";

contract BlockHashIsmTest is Test {
    BlockHashIsm ism;
    MockBlockHashOracle oracle;
    address originMailbox = address(0x1234);

    // Static test data
    uint256 constant TEST_BLOCK_HEIGHT = 100;
    // NOTE: This has been generated via lib/generateRlpHeader.js and is a valid RLP encoded header.
    bytes constant VALID_RLP_HEADER =
        hex"f90219a0198723e0ddf20153951c6304093cbd97fd306c5db03287c5586c0430a986080da01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d4934794dafea492d9c6733ae3d56b7ed1adb60692c98bc5a008b7443c83a93d4711f5c63e738c27c54a932522405b37b4ca7868a944105deba097dd0200249a35da2c73b366612c2d9c3d112e83ef5e0277cded1352c66628baa0d925652022fa6da2ca5b9781ab2fd50cb05d3b4741a327f52322e2b7917d3a2fb9010053f146f2484e1cb4b24d5a028329290bd702c80fe8465d9e55e900682e28809f405df83fd48d530900908f3c62de69000a530db688092c03d9406056852a0152220084ec4f8daa3c2c226e9878b08578163190e80b482ad30604c3649c25002037100c2086aaa3291c0407418431ebaa851804a6212996a206840875360bd84d2123065273780b9d04e4950c029a40d3e062b2697b048e4f3629824234ba00318a680d70eab6a9d740e38de89394d492c4c2ad6424bac19d4bcf08ca4044435aca49069e6907893082841ca20446b2220f4053121e7cc4b8cb84095f1a32320e105a20c821f675418c0d13308a896040d67550322ac88444e20080b36467040100840112a8808401c9c38083f7e9ab8464ea268f9f496c6c756d696e61746520446d6f63726174697a6520447374726962757465a08b14d8532c673877dcc735caf93392bd05603456b7745fc3f012a3e3b156acfa0085050ead8e39";
    bytes32 constant VALID_BLOCK_HASH = keccak256(VALID_RLP_HEADER);

    function addressToBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // We use abi.encodePacked() because the Hyperlane message format is a tightly packed structure
    // rather than a nested ABI-encoded object (which abi.encode() would produce).
    function encodeMessage(
        uint8 version,
        uint32 nonce,
        uint32 origin,
        address sender,
        uint32 destination,
        address recipient,
        bytes memory body
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                version,
                nonce,
                origin,
                addressToBytes32(sender),
                destination,
                addressToBytes32(recipient),
                body
            );
    }

    function setUp() public {
        oracle = new MockBlockHashOracle(1);
        ism = new BlockHashIsm(address(oracle), originMailbox);
    }

    function testVerifyValid() public {
        oracle.setBlockHash(TEST_BLOCK_HEIGHT, uint256(VALID_BLOCK_HASH));
        bytes memory metadata = abi.encode(TEST_BLOCK_HEIGHT, VALID_RLP_HEADER);

        bytes memory message = encodeMessage(
            1,
            1,
            1,
            originMailbox,
            5,
            address(0xDEADBEEF),
            bytes("hello")
        );

        assertTrue(ism.verify(metadata, message));
    }

    function testVerifyInvalidHash() public {
        oracle.setBlockHash(TEST_BLOCK_HEIGHT, uint256(keccak256("wrong")));
        bytes memory metadata = abi.encode(TEST_BLOCK_HEIGHT, VALID_RLP_HEADER);

        bytes memory message = encodeMessage(
            1,
            1,
            1,
            originMailbox,
            5,
            address(0xDEADBEEF),
            bytes("hello")
        );

        assertFalse(ism.verify(metadata, message));
    }
}
