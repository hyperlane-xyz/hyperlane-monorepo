// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "../contracts/libs/TypeCasts.sol";
import "../contracts/test/TestMailbox.sol";
import "../contracts/CheckpointFraudProofs.sol";
import "../contracts/test/TestMerkleTreeHook.sol";
import "../contracts/test/TestPostDispatchHook.sol";

// must have keys ordered alphabetically
struct Proof {
    uint32 index;
    bytes32 leaf;
    bytes32[] path; // cannot be static length or json parsing breaks
}

// must have keys ordered alphabetically
struct Fixture {
    bytes32 expectedRoot;
    string[] leaves;
    Proof[] proofs;
    string testName;
}

uint8 constant FIXTURE_COUNT = 1;

contract CheckpointFraudProofsTest is Test {
    using TypeCasts for address;
    using stdJson for string;

    uint32 localDomain = 1000;
    uint32 remoteDomain = 2000;

    TestMailbox mailbox;
    TestMerkleTreeHook merkleTreeHook;

    CheckpointFraudProofs cfp;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        cfp = new CheckpointFraudProofs();
    }

    function loadFixture(
        Fixture memory fixture
    )
        internal
        returns (Checkpoint memory checkpoint, bytes32[32] memory proof)
    {
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        bytes32 merkleBytes = address(merkleTreeHook).addressToBytes32();

        for (uint32 index = 0; index < fixture.leaves.length; index++) {
            bytes32 leaf = ECDSA.toEthSignedMessageHash(
                abi.encodePacked(fixture.leaves[index])
            );
            merkleTreeHook.insert(leaf);
            checkpoint = Checkpoint(
                localDomain,
                merkleBytes,
                fixture.expectedRoot,
                index,
                leaf
            );
        }
        proof = parseProof(fixture.proofs[fixture.proofs.length - 1]);
    }

    function parseProof(
        Proof memory proof
    ) internal pure returns (bytes32[32] memory path) {
        for (uint8 i = 0; i < proof.path.length; i++) {
            path[i] = proof.path[i];
        }
    }

    function readFixture(
        uint8 index
    ) internal returns (Fixture memory fixture) {
        string memory json = vm.readFile("../vectors/merkle.json");
        bytes memory data = json.parseRaw(
            string.concat(".[", vm.toString(index), "]")
        );
        fixture = abi.decode(data, (Fixture));
        console.log(fixture.testName);
    }

    function test_isLocal(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, ) = loadFixture(
            readFixture(fixtureIndex)
        );

        assertTrue(cfp.isLocal(checkpoint));
        checkpoint.origin = remoteDomain;
        assertFalse(cfp.isLocal(checkpoint));
    }

    function test_isPremature(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);
        (Checkpoint memory checkpoint, ) = loadFixture(
            readFixture(fixtureIndex)
        );
        assertFalse(cfp.isPremature(checkpoint));
        checkpoint.index += 1;
        assertTrue(cfp.isPremature(checkpoint));
    }

    function test_RevertWhenNotLocal_isPremature(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);
        (Checkpoint memory checkpoint, ) = loadFixture(
            readFixture(fixtureIndex)
        );
        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isPremature(checkpoint);
    }

    function test_isFraudulentMessageId(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        cfp.storeLatestCheckpoint(address(merkleTreeHook));

        assertFalse(
            cfp.isFraudulentMessageId(checkpoint, proof, checkpoint.messageId)
        );

        bytes32 actualMessageId = checkpoint.messageId;
        checkpoint.messageId = ~checkpoint.messageId;
        assertTrue(
            cfp.isFraudulentMessageId(checkpoint, proof, actualMessageId)
        );
    }

    function test_RevertWhenNotStored_isFraudulentMessageId(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        vm.expectRevert("message must be member of stored checkpoint");
        cfp.isFraudulentMessageId(checkpoint, proof, checkpoint.messageId);
    }

    function test_RevertWhenNotLocal_isFraudulentMessageId(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isFraudulentMessageId(checkpoint, proof, checkpoint.messageId);
    }

    function test_IsFraudulentRoot(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        cfp.storeLatestCheckpoint(address(merkleTreeHook));
        assertFalse(cfp.isFraudulentRoot(checkpoint, proof));

        checkpoint.root = ~checkpoint.root;
        assertTrue(cfp.isFraudulentRoot(checkpoint, proof));
    }

    function test_RevertWhenNotStored_isFraudulentRoot(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        vm.expectRevert("message must be member of stored checkpoint");
        cfp.isFraudulentRoot(checkpoint, proof);
    }

    function test_RevertWhenNotLocal_isFraudulentRoot(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint memory checkpoint, bytes32[32] memory proof) = loadFixture(
            readFixture(fixtureIndex)
        );

        checkpoint.origin = remoteDomain;
        vm.expectRevert("must be local checkpoint");
        cfp.isFraudulentRoot(checkpoint, proof);
    }
}
