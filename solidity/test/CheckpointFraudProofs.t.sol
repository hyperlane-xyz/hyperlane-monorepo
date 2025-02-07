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

uint8 constant FIXTURE_COUNT = 5;

contract CheckpointFraudProofsTest is Test {
    using TypeCasts for address;
    using stdJson for string;

    uint32 localDomain = 1000;
    uint32 remoteDomain = 2000;

    string json = vm.readFile("../vectors/merkle.json");

    TestMailbox mailbox;
    TestMerkleTreeHook merkleTreeHook;

    CheckpointFraudProofs cfp;

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        cfp = new CheckpointFraudProofs();
    }

    function loadFixture(
        uint32 fixtureIndex
    )
        internal
        returns (
            Checkpoint[] memory checkpoints,
            bytes32[TREE_DEPTH][] memory proofs
        )
    {
        bytes memory data = json.parseRaw(
            string.concat(".[", vm.toString(fixtureIndex), "]")
        );
        Fixture memory fixture = abi.decode(data, (Fixture));
        console.log(fixture.testName);

        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        bytes32 merkleBytes = address(merkleTreeHook).addressToBytes32();

        checkpoints = new Checkpoint[](fixture.leaves.length);
        proofs = new bytes32[TREE_DEPTH][](fixture.proofs.length);

        for (uint32 index = 0; index < fixture.leaves.length; index++) {
            bytes32 leaf = ECDSA.toEthSignedMessageHash(
                abi.encodePacked(fixture.leaves[index])
            );
            merkleTreeHook.insert(leaf);
            checkpoints[index] = Checkpoint(
                localDomain,
                merkleBytes,
                merkleTreeHook.root(),
                index,
                leaf
            );
            proofs[index] = parseProof(fixture.proofs[index]);
        }

        assert(fixture.expectedRoot == merkleTreeHook.root());
    }

    function parseProof(
        Proof memory proof
    ) internal pure returns (bytes32[TREE_DEPTH] memory path) {
        for (uint8 i = 0; i < proof.path.length; i++) {
            path[i] = proof.path[i];
        }
    }

    function test_isLocal(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (Checkpoint[] memory checkpoints, ) = loadFixture(fixtureIndex);

        for (uint32 i = 0; i < checkpoints.length; i++) {
            assertTrue(cfp.isLocal(checkpoints[i]));
            checkpoints[i].origin = remoteDomain;
            assertFalse(cfp.isLocal(checkpoints[i]));
        }
    }

    function test_isPremature(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);
        (Checkpoint[] memory checkpoints, ) = loadFixture(fixtureIndex);

        for (uint32 i = 0; i < checkpoints.length; i++) {
            assertFalse(cfp.isPremature(checkpoints[i]));
        }

        Checkpoint memory prematureCheckpoint = Checkpoint(
            localDomain,
            address(merkleTreeHook).addressToBytes32(),
            0,
            merkleTreeHook.count(),
            0
        );
        assertTrue(cfp.isPremature(prematureCheckpoint));

        merkleTreeHook.insert(bytes32("0xdeadbeef"));
        assertFalse(cfp.isPremature(prematureCheckpoint));
    }

    function test_RevertWhenNotLocal_isPremature(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);
        (Checkpoint[] memory checkpoints, ) = loadFixture(fixtureIndex);
        for (uint32 i = 0; i < checkpoints.length; i++) {
            checkpoints[i].origin = remoteDomain;
            vm.expectRevert("must be local checkpoint");
            cfp.isPremature(checkpoints[i]);
        }
    }

    function test_isFraudulentMessageId(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        // cannot store checkpoint when count is 0
        if (checkpoints.length != 0) {
            cfp.storeLatestCheckpoint(address(merkleTreeHook));
        }

        for (uint32 i = 0; i < checkpoints.length; i++) {
            assertFalse(
                cfp.isFraudulentMessageId(
                    checkpoints[i],
                    proofs[i],
                    checkpoints[i].messageId
                )
            );
            bytes32 actualMessageId = checkpoints[i].messageId;
            checkpoints[i].messageId = ~actualMessageId;
            assertTrue(
                cfp.isFraudulentMessageId(
                    checkpoints[i],
                    proofs[i],
                    actualMessageId
                )
            );
        }
    }

    function test_RevertWhenNotStored_isFraudulentMessageId(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        for (uint32 index = 0; index < checkpoints.length; index++) {
            vm.expectRevert("message must be member of stored checkpoint");
            cfp.isFraudulentMessageId(
                checkpoints[index],
                proofs[index],
                checkpoints[index].messageId
            );
        }

        // cannot store checkpoint when count is 0
        if (checkpoints.length != 0) {
            cfp.storeLatestCheckpoint(address(merkleTreeHook));
        }

        // providing an invalid merkle proof should revert with not stored
        for (uint32 index = 0; index < checkpoints.length; index++) {
            proofs[index][0] = ~proofs[index][0];
            vm.expectRevert("message must be member of stored checkpoint");
            cfp.isFraudulentMessageId(
                checkpoints[index],
                proofs[index],
                checkpoints[index].messageId
            );
        }
    }

    function test_RevertWhenNotLocal_isFraudulentMessageId(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        for (uint32 i = 0; i < checkpoints.length; i++) {
            checkpoints[i].origin = remoteDomain;
            vm.expectRevert("must be local checkpoint");
            cfp.isFraudulentMessageId(
                checkpoints[i],
                proofs[i],
                checkpoints[i].messageId
            );
        }
    }

    function test_IsFraudulentRoot(uint8 fixtureIndex) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        // cannot store checkpoint when count is 0
        if (checkpoints.length != 0) {
            cfp.storeLatestCheckpoint(address(merkleTreeHook));
        }

        // check all messages against latest stored checkpoint
        for (uint32 i = 0; i < checkpoints.length; i++) {
            assertFalse(cfp.isFraudulentRoot(checkpoints[i], proofs[i]));
            checkpoints[i].root = ~checkpoints[i].root;
            assertTrue(cfp.isFraudulentRoot(checkpoints[i], proofs[i]));
        }
    }

    function test_RevertWhenNotStored_isFraudulentRoot(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        for (uint32 index = 0; index < checkpoints.length; index++) {
            vm.expectRevert("message must be member of stored checkpoint");
            cfp.isFraudulentRoot(checkpoints[index], proofs[index]);
        }

        // cannot store checkpoint when count is 0
        if (checkpoints.length != 0) {
            cfp.storeLatestCheckpoint(address(merkleTreeHook));
        }

        // providing an invalid merkle proof should revert with not stored
        for (uint32 index = 0; index < checkpoints.length; index++) {
            proofs[index][0] = ~proofs[index][0];
            vm.expectRevert("message must be member of stored checkpoint");
            cfp.isFraudulentRoot(checkpoints[index], proofs[index]);
        }
    }

    function test_RevertWhenNotLocal_isFraudulentRoot(
        uint8 fixtureIndex
    ) public {
        vm.assume(fixtureIndex < FIXTURE_COUNT);

        (
            Checkpoint[] memory checkpoints,
            bytes32[32][] memory proofs
        ) = loadFixture(fixtureIndex);

        for (uint32 i = 0; i < checkpoints.length; i++) {
            checkpoints[i].origin = remoteDomain;
            vm.expectRevert("must be local checkpoint");
            cfp.isFraudulentRoot(checkpoints[i], proofs[i]);
        }
    }
}
