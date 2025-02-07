// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IStaticWeightedMultisigIsm} from "../../contracts/interfaces/isms/IWeightedMultisigIsm.sol";
import {StaticMerkleRootWeightedMultisigIsmFactory, StaticMessageIdWeightedMultisigIsmFactory} from "../../contracts/isms/multisig/WeightedMultisigIsm.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {StaticWeightedValidatorSetFactory} from "../../contracts/libs/StaticWeightedValidatorSetFactory.sol";
import {AbstractStaticWeightedMultisigIsm} from "../../contracts/isms/multisig/AbstractWeightedMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {MessageIdMultisigIsmMetadata} from "../../contracts/isms/libs/MessageIdMultisigIsmMetadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AbstractMultisigIsmTest, MerkleRootMultisigIsmTest, MessageIdMultisigIsmTest} from "./MultisigIsm.t.sol";

abstract contract AbstractStaticWeightedMultisigIsmTest is
    AbstractMultisigIsmTest
{
    using Math for uint256;
    using Message for bytes;
    using TypeCasts for address;

    StaticWeightedValidatorSetFactory weightedFactory;
    AbstractStaticWeightedMultisigIsm weightedIsm;

    uint96 public constant TOTAL_WEIGHT = 1e10;

    function addValidators(
        uint96 threshold,
        uint8 n,
        bytes32 seed
    )
        internal
        returns (
            uint256[] memory,
            IStaticWeightedMultisigIsm.ValidatorInfo[] memory
        )
    {
        bound(threshold, 0, TOTAL_WEIGHT);
        uint256[] memory keys = new uint256[](n);
        IStaticWeightedMultisigIsm.ValidatorInfo[]
            memory validators = new IStaticWeightedMultisigIsm.ValidatorInfo[](
                n
            );

        uint256 remainingWeight = TOTAL_WEIGHT;
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            validators[i].signingAddress = vm.addr(key);

            if (i == n - 1) {
                validators[i].weight = uint96(remainingWeight);
            } else {
                uint256 weight = (uint256(
                    keccak256(abi.encode(seed, "weight", i))
                ) % (remainingWeight + 1));
                validators[i].weight = uint96(weight);
                remainingWeight -= weight;
            }
        }

        ism = IInterchainSecurityModule(
            weightedFactory.deploy(validators, threshold)
        );
        weightedIsm = AbstractStaticWeightedMultisigIsm(address(ism));
        return (keys, validators);
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    ) internal virtual override returns (bytes memory) {
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

        uint96 threshold = uint96(
            (uint256(m)).mulDiv(TOTAL_WEIGHT, type(uint8).max)
        );

        (
            uint256[] memory keys,
            IStaticWeightedMultisigIsm.ValidatorInfo[] memory allValidators
        ) = addValidators(threshold, n, seed);

        (, uint96 thresholdWeight) = weightedIsm.validatorsAndThresholdWeight(
            message
        );

        bytes memory metadata = metadataPrefix(message);
        fixtureInit();

        uint96 totalWeight = 0;
        uint256 signerCount = 0;

        while (
            totalWeight < thresholdWeight && signerCount < allValidators.length
        ) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(
                keys[signerCount],
                digest
            );

            metadata = abi.encodePacked(metadata, r, s, v);

            fixtureAppendSignature(signerCount, v, r, s);

            totalWeight += allValidators[signerCount].weight;
            signerCount++;
        }

        writeFixture(metadata, uint8(signerCount), n);

        return metadata;
    }

    function test_verify_revertInsufficientWeight(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);

        uint256 signatureCount = weightedIsm.signatureCount(metadata);
        vm.assume(signatureCount >= 1);

        uint256 newLength = metadata.length - 65;
        bytes memory insufficientMetadata = new bytes(newLength);

        for (uint256 i = 0; i < newLength; i++) {
            insufficientMetadata[i] = metadata[i];
        }

        vm.expectRevert("Insufficient validator weight");
        ism.verify(insufficientMetadata, message);
    }

    function test_verify_revertWhen_duplicateSignatures(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public virtual override {
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

        if (weightedIsm.signatureCount(metadata) >= 2) {
            vm.expectRevert("Invalid signer");
            ism.verify(duplicateMetadata, message);
        }
    }
}

contract StaticMerkleRootWeightedMultisigIsmTest is
    MerkleRootMultisigIsmTest,
    AbstractStaticWeightedMultisigIsmTest
{
    function setUp() public override {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        weightedFactory = new StaticMerkleRootWeightedMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    )
        internal
        override(AbstractMultisigIsmTest, AbstractStaticWeightedMultisigIsmTest)
        returns (bytes memory)
    {
        return
            AbstractStaticWeightedMultisigIsmTest.getMetadata(
                m,
                n,
                seed,
                message
            );
    }

    function test_verify_revertWhen_duplicateSignatures(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    )
        public
        override(AbstractMultisigIsmTest, AbstractStaticWeightedMultisigIsmTest)
    {
        AbstractStaticWeightedMultisigIsmTest
            .test_verify_revertWhen_duplicateSignatures(
                destination,
                recipient,
                body,
                m,
                n,
                seed
            );
    }

    function testThresholdExceedsLength() public override {
        // no-op
    }

    function testZeroThreshold() public override {
        // no-op
    }
}

contract StaticMessageIdWeightedMultisigIsmTest is
    MessageIdMultisigIsmTest,
    AbstractStaticWeightedMultisigIsmTest
{
    function setUp() public override {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();
        weightedFactory = new StaticMessageIdWeightedMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory message
    )
        internal
        override(AbstractMultisigIsmTest, AbstractStaticWeightedMultisigIsmTest)
        returns (bytes memory)
    {
        return
            AbstractStaticWeightedMultisigIsmTest.getMetadata(
                m,
                n,
                seed,
                message
            );
    }

    function test_verify_revertWhen_duplicateSignatures(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    )
        public
        override(AbstractMultisigIsmTest, AbstractStaticWeightedMultisigIsmTest)
    {
        AbstractStaticWeightedMultisigIsmTest
            .test_verify_revertWhen_duplicateSignatures(
                destination,
                recipient,
                body,
                m,
                n,
                seed
            );
    }

    function testThresholdExceedsLength() public override {
        // no-op
    }

    function testZeroThreshold() public override {
        // no-op
    }
}
