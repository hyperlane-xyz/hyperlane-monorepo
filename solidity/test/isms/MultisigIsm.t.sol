// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import "@openzeppelin/contracts/utils/Strings.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMerkleRootMultisigIsmFactory, StaticMessageIdMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsm.sol";
import {MerkleRootMultisigIsmMetadata} from "../../contracts/isms/libs/MerkleRootMultisigIsmMetadata.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {IThresholdAddressFactory} from "../../contracts/interfaces/IThresholdAddressFactory.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MerkleTreeHook} from "../../contracts/hooks/MerkleTreeHook.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {ThresholdTestUtils} from "./IsmTestUtils.sol";
import {StorageMessageIdMultisigIsm, StorageMerkleRootMultisigIsm, StorageMessageIdMultisigIsmFactory, StorageMerkleRootMultisigIsmFactory, AbstractStorageMultisigIsm} from "../../contracts/isms/multisig/StorageMultisigIsm.sol";

uint8 constant MAX_VALIDATORS = 20;

/// @notice since we removed merkle tree from the mailbox, we need to include the MerkleTreeHook in the test
abstract contract AbstractMultisigIsmTest is Test {
    using Message for bytes;
    using TypeCasts for address;
    using Strings for uint256;
    using Strings for uint8;

    string constant fixtureKey = "fixture";
    string constant signatureKey = "signature";
    string constant signaturesKey = "signatures";
    string constant prefixKey = "prefix";

    uint32 constant ORIGIN = 11;
    IThresholdAddressFactory factory;
    IInterchainSecurityModule ism;
    TestMerkleTreeHook internal merkleTreeHook;
    TestPostDispatchHook internal noopHook;
    TestMailbox mailbox;

    function metadataPrefix(
        bytes memory message
    ) internal virtual returns (bytes memory);

    function fixtureInit() internal {
        vm.serializeUint(fixtureKey, "type", uint256(ism.moduleType()));
        string memory prefix = vm.serializeString(prefixKey, "dummy", "dummy");
        vm.serializeString(fixtureKey, "prefix", prefix);
    }

    function fixtureAppendSignature(
        uint256 index,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        vm.serializeUint(signatureKey, "v", uint256(v));
        vm.serializeBytes32(signatureKey, "r", r);
        string memory signature = vm.serializeBytes32(signatureKey, "s", s);
        vm.serializeString(signaturesKey, index.toString(), signature);
    }

    function writeFixture(bytes memory metadata, uint8 m, uint8 n) internal {
        vm.serializeString(
            fixtureKey,
            "signatures",
            vm.serializeString(signaturesKey, "dummy", "dummy")
        );

        string memory fixturePath = string(
            abi.encodePacked(
                "./fixtures/multisig/",
                m.toString(),
                "-",
                n.toString(),
                ".json"
            )
        );
        vm.writeJson(
            vm.serializeBytes(fixtureKey, "encoded", metadata),
            fixturePath
        );
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) internal virtual returns (bytes memory) {
        bytes32 digest;
        {
            uint32 domain = mailbox.localDomain();
            (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
            bytes32 messageId = message.id();
            bytes32 merkleTreeAddress = address(merkleTreeHook)
                .addressToBytes32();
            digest = CheckpointLib.digest(
                domain,
                merkleTreeAddress,
                root,
                index,
                messageId
            );
        }

        uint256[] memory signers = ThresholdTestUtils.choose(
            m,
            addValidators(m, n, seed),
            seed
        );

        bytes memory metadata = metadataPrefix(message);
        fixtureInit();

        for (uint256 i = 0; i < m; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);

            metadata = abi.encodePacked(metadata, r, s, v);
            fixtureAppendSignature(i, v, r, s);
        }

        writeFixture(metadata, m, n);

        return metadata;
    }

    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal virtual returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](n);
        address[] memory addresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            addresses[i] = vm.addr(key);
        }
        ism = IMultisigIsm(factory.deploy(addresses, m));
        return keys;
    }

    function getMessage(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body
    ) internal returns (bytes memory) {
        bytes memory message = mailbox.buildOutboundMessage(
            destination,
            recipient,
            body
        );
        merkleTreeHook.insert(message.id());
        return message;
    }

    function testVerify(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < MAX_VALIDATORS);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);
        assertTrue(ism.verify(metadata, message));
    }

    function test_RevertWhen_badMetadata(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < MAX_VALIDATORS);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);

        // changing single byte in metadata should fail signature verification
        uint256 index = uint256(seed) % metadata.length;
        metadata[index] = ~metadata[index];
        vm.expectRevert();
        ism.verify(metadata, message);
    }

    function test_verify_revertWhen_duplicateSignatures(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public virtual {
        vm.assume(1 < m && m <= n && n < 10);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);

        bytes memory duplicateMetadata = new bytes(metadata.length);
        for (uint256 i = 0; i < metadata.length - 65; i++) {
            duplicateMetadata[i] = metadata[i];
        }
        for (uint256 i = 0; i < 65; i++) {
            duplicateMetadata[metadata.length - 65 + i] = metadata[
                metadata.length - 130 + i
            ];
        }

        vm.expectRevert("!threshold");
        ism.verify(duplicateMetadata, message);
    }

    function testZeroThreshold() public virtual {
        vm.expectRevert("Invalid threshold");
        factory.deploy(new address[](1), 0);
    }

    function testThresholdExceedsLength() public virtual {
        vm.expectRevert("Invalid threshold");
        factory.deploy(new address[](1), 2);
    }
}

contract MerkleRootMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;
    using Message for bytes;
    using Strings for uint256;

    string constant proofKey = "proof";

    function setUp() public virtual {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        factory = new StaticMerkleRootMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function fixturePrefix(
        uint32 checkpointIndex,
        bytes32 merkleTreeAddress,
        bytes32 messageId,
        bytes32[32] memory proof
    ) internal {
        vm.serializeUint(prefixKey, "index", uint256(checkpointIndex));
        vm.serializeBytes32(prefixKey, "merkleTree", merkleTreeAddress);
        vm.serializeUint(prefixKey, "signedIndex", uint256(checkpointIndex));
        vm.serializeBytes32(prefixKey, "id", messageId);

        for (uint256 i = 0; i < 32; i++) {
            vm.serializeBytes32(proofKey, i.toString(), proof[i]);
        }
        string memory proofString = vm.serializeString(
            proofKey,
            "dummy",
            "dummy"
        );
        vm.serializeString(prefixKey, "proof", proofString);
    }

    // TODO: test merkleIndex != signedIndex
    function metadataPrefix(
        bytes memory message
    ) internal override returns (bytes memory) {
        uint32 checkpointIndex = uint32(merkleTreeHook.count() - 1);
        bytes32[32] memory proof = merkleTreeHook.proof();
        bytes32 messageId = message.id();
        bytes32 merkleTreeAddress = address(merkleTreeHook).addressToBytes32();

        fixturePrefix(checkpointIndex, merkleTreeAddress, messageId, proof);

        return
            abi.encodePacked(
                merkleTreeAddress,
                checkpointIndex,
                messageId,
                proof,
                checkpointIndex
            );
    }
}

contract MessageIdMultisigIsmTest is AbstractMultisigIsmTest {
    using TypeCasts for address;

    function setUp() public virtual {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

        factory = new StaticMessageIdMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function fixturePrefix(
        bytes32 root,
        uint32 index,
        bytes32 merkleTreeAddress
    ) internal {
        vm.serializeBytes32(prefixKey, "root", root);
        vm.serializeUint(prefixKey, "signedIndex", uint256(index));
        vm.serializeBytes32(prefixKey, "merkleTree", merkleTreeAddress);
    }

    function metadataPrefix(
        bytes memory
    ) internal override returns (bytes memory metadata) {
        (bytes32 root, uint32 index) = merkleTreeHook.latestCheckpoint();
        bytes32 merkleTreeAddress = address(merkleTreeHook).addressToBytes32();

        fixturePrefix(root, index, merkleTreeAddress);

        return abi.encodePacked(merkleTreeAddress, root, index);
    }
}

abstract contract StorageMultisigIsmTest is AbstractMultisigIsmTest {
    event ValidatorsAndThresholdSet(address[] validators, uint8 threshold);
    event Initialized(uint8 version);
    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    function test_initialize(
        bytes32 seed,
        address[] memory validators,
        uint8 threshold
    ) public {
        vm.assume(
            0 < threshold &&
                threshold <= validators.length &&
                validators.length <= MAX_VALIDATORS
        );

        addValidators(threshold, uint8(validators.length), seed);

        vm.expectRevert("Initializable: contract is already initialized");
        AbstractStorageMultisigIsm(address(ism)).initialize(
            address(this),
            validators,
            threshold
        );
    }

    function test_setValidatorsAndThreshold(
        bytes32 seed,
        address[] memory validators,
        uint8 threshold
    ) public {
        vm.assume(
            0 < threshold &&
                threshold <= validators.length &&
                validators.length <= MAX_VALIDATORS
        );

        addValidators(threshold, uint8(validators.length), seed);

        AbstractStorageMultisigIsm storageIsm = AbstractStorageMultisigIsm(
            address(ism)
        );

        address owner = storageIsm.owner();
        address antiOwner = address(~bytes20(owner));
        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(antiOwner);
        storageIsm.setValidatorsAndThreshold(validators, threshold);

        vm.expectRevert("Invalid threshold");
        vm.prank(owner);
        storageIsm.setValidatorsAndThreshold(
            validators,
            uint8(validators.length + 1)
        );

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit ValidatorsAndThresholdSet(validators, threshold);
        storageIsm.setValidatorsAndThreshold(validators, threshold);
        (address[] memory _validators, uint8 _threshold) = storageIsm
            .validatorsAndThreshold("0x");
        assertEq(_threshold, threshold);
        assertEq(_validators, validators);
    }
}

contract StorageMessageIdMultisigIsmTest is
    StorageMultisigIsmTest,
    MessageIdMultisigIsmTest
{
    function setUp() public override {
        super.setUp();
        factory = new StorageMessageIdMultisigIsmFactory();
    }
}

contract StorageMerkleRootMultisigIsmTest is
    StorageMultisigIsmTest,
    MerkleRootMultisigIsmTest
{
    function setUp() public override {
        super.setUp();
        factory = new StorageMerkleRootMultisigIsmFactory();
    }
}
