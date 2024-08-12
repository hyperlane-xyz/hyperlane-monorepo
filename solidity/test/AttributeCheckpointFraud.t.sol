// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "../contracts/libs/CheckpointLib.sol";

import "../contracts/test/TestMailbox.sol";
import "../contracts/test/TestMerkleTreeHook.sol";

import "../contracts/CheckpointFraudProofs.sol";
import "../contracts/AttributeCheckpointFraud.sol";

contract AttributeCheckpointFraudTest is Test {
    using CheckpointLib for Checkpoint;
    using TypeCasts for address;

    uint32 domain = 1;

    TestMailbox mailbox;
    TestMerkleTreeHook merkleTreeHook;

    AttributeCheckpointFraud acf;

    function setUp() public {
        acf = new AttributeCheckpointFraud();
        mailbox = new TestMailbox(domain);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
    }

    function test_whitelist() public {
        vm.expectRevert("merkle tree must be a valid contract");
        acf.whitelist(address(0));

        vm.prank(address(0x1));
        vm.expectRevert("Ownable: caller is not the owner");
        acf.whitelist(address(merkleTreeHook));

        acf.whitelist(address(merkleTreeHook));
        assert(acf.merkleTreeWhitelist(address(merkleTreeHook)));
    }

    function mockAttribute(
        bytes32 digest,
        address signer,
        FraudType fraudType
    ) internal {
        bytes32 slot = keccak256(
            abi.encode(digest, keccak256(abi.encode(signer, uint(2))))
        );
        vm.store(address(acf), slot, bytes32(uint(fraudType)));
    }

    function sign(
        Checkpoint memory checkpoint,
        uint256 privateKey
    ) internal pure returns (bytes memory signature) {
        vm.assume(
            privateKey > 0 &&
                privateKey <
                115792089237316195423570985008687907852837564279074904382605163141518161494337
        );

        bytes32 digest = checkpoint.digest();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // function test_unattributed(
    //     Checkpoint calldata checkpoint,
    //     uint256 privateKey
    // ) public {
    //     vm.assume(
    //         privateKey > 0 &&
    //             privateKey <
    //             115792089237316195423570985008687907852837564279074904382605163141518161494337
    //     );

    //     bytes32 digest = checkpoint.digest();
    //     (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
    //     bytes memory signature = abi.encodePacked(r, s, v);
    //     (bytes32 computedDigest, address signer) = acf.unattributed(
    //         checkpoint,
    //         signature
    //     );
    //     assertEq(digest, computedDigest);
    //     assertEq(signer, vm.addr(privateKey));

    //     mockAttribute(digest, signer, FraudType.Whitelist);
    //     vm.expectRevert("fraud already attributed to signer for digest");
    //     acf.unattributed(checkpoint, signature);
    // }

    function test_attributeWhitelist(
        Checkpoint memory checkpoint,
        uint256 privateKey
    ) public {
        checkpoint.origin = domain;
        checkpoint.merkleTree = address(merkleTreeHook).addressToBytes32();

        bytes memory signature = sign(checkpoint, privateKey);

        acf.attributeWhitelist(checkpoint, signature);
        assert(
            acf.attributions(checkpoint, signature).fraudType ==
                FraudType.Whitelist
        );

        vm.expectRevert("fraud already attributed to signer for digest");
        acf.attributeWhitelist(checkpoint, signature);

        // mockAttribute(digest, signer, FraudType.NotProven);
        acf.whitelist(address(merkleTreeHook));
        vm.expectRevert("merkle tree is whitelisted");
        acf.attributeWhitelist(checkpoint, signature);

        checkpoint.origin = domain + 1;
        vm.expectRevert("checkpoint must be local");
        acf.attributeWhitelist(checkpoint, signature);
    }

    function test_attributePremature(
        Checkpoint calldata checkpoint,
        uint256 privateKey
    ) public {
        bytes memory signature = sign(checkpoint, privateKey);

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isPremature.selector,
                checkpoint
            ),
            abi.encode(false)
        );
        vm.expectRevert("checkpoint must be premature");
        acf.attributePremature(checkpoint, signature);

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isPremature.selector,
                checkpoint
            ),
            abi.encode(true)
        );
        acf.attributePremature(checkpoint, signature);
        assert(
            acf.attributions(checkpoint, signature).fraudType ==
                FraudType.Premature
        );

        vm.expectRevert("fraud already attributed to signer for digest");
        acf.attributePremature(checkpoint, signature);
    }

    function test_attributeMessageId(
        Checkpoint memory checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        uint256 privateKey
    ) public {
        bytes memory signature = sign(checkpoint, privateKey);

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isFraudulentMessageId.selector
            ),
            abi.encode(false)
        );
        vm.expectRevert("checkpoint must have fraudulent message ID");
        acf.attributeMessageId(
            checkpoint,
            proof,
            checkpoint.messageId,
            signature
        );

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isFraudulentMessageId.selector
            ),
            abi.encode(true)
        );
        acf.attributeMessageId(
            checkpoint,
            proof,
            checkpoint.messageId,
            signature
        );
        assert(
            acf.attributions(checkpoint, signature).fraudType ==
                FraudType.MessageId
        );

        vm.expectRevert("fraud already attributed to signer for digest");
        acf.attributeMessageId(
            checkpoint,
            proof,
            checkpoint.messageId,
            signature
        );
    }

    function test_attributeRoot(
        Checkpoint memory checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        uint256 privateKey
    ) public {
        bytes memory signature = sign(checkpoint, privateKey);

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isFraudulentRoot.selector
            ),
            abi.encode(false)
        );
        vm.expectRevert("checkpoint must have fraudulent root");
        acf.attributeRoot(checkpoint, proof, signature);

        vm.mockCall(
            address(acf.checkpointFraudProofs()),
            abi.encodeWithSelector(
                CheckpointFraudProofs.isFraudulentRoot.selector
            ),
            abi.encode(true)
        );
        acf.attributeRoot(checkpoint, proof, signature);
        assert(
            acf.attributions(checkpoint, signature).fraudType == FraudType.Root
        );

        vm.expectRevert("fraud already attributed to signer for digest");
        acf.attributeRoot(checkpoint, proof, signature);
    }
}
