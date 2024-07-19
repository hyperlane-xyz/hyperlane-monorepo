// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IWeightedMultisigIsm} from "../../contracts/interfaces/isms/IWeightedMultisigIsm.sol";
import {MerkleRootWeightedMultisigIsm, MessageIdWeightedMultisigIsm} from "../../contracts/isms/multisig/WeightedMultisigIsm.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {AbstractWeightedMultisigIsm} from "../../contracts/isms/multisig/AbstractWeightedMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {MessageIdMultisigIsmMetadata} from "../../contracts/isms/libs/MessageIdMultisigIsmMetadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AbstractMultisigIsmTest, MerkleRootMultisigIsmTest, MessageIdMultisigIsmTest} from "./MultisigIsm.t.sol";

abstract contract AbstractWeightedMultisigIsmTest is AbstractMultisigIsmTest {
    using Math for uint256;
    using Message for bytes;
    using TypeCasts for address;

    AbstractWeightedMultisigIsm weightedIsm;

    uint96 public constant BASIS_POINTS = 10000;

    function addValidators(
        uint96 threshold,
        uint8 n,
        bytes32 seed
    )
        internal
        returns (uint256[] memory, IWeightedMultisigIsm.ValidatorInfo[] memory)
    {
        bound(threshold, 0, BASIS_POINTS);
        uint256[] memory keys = new uint256[](n);
        IWeightedMultisigIsm.ValidatorInfo[]
            memory validators = new IWeightedMultisigIsm.ValidatorInfo[](n);

        uint256 remainingWeight = BASIS_POINTS;
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            validators[i].signingKey = vm.addr(key);

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

        address deployedIsm = _initializeIsm(validators, threshold);

        ism = IInterchainSecurityModule(deployedIsm);
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
            (uint256(m)).mulDiv(BASIS_POINTS, type(uint8).max)
        );

        (
            uint256[] memory keys,
            IWeightedMultisigIsm.ValidatorInfo[] memory allValidators
        ) = addValidators(threshold, n, seed);

        uint96 thresholdWeight = weightedIsm.thresholdWeight();

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

    function testVerify_revertInsufficientWeight(
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

    function _initializeIsm(
        IWeightedMultisigIsm.ValidatorInfo[] memory validators,
        uint96 threshold
    ) internal virtual returns (address);
}

contract MerkleRootWeightedMultisigIsmTest is
    MerkleRootMultisigIsmTest,
    AbstractWeightedMultisigIsmTest
{
    function setUp() public override {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

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
        override(AbstractMultisigIsmTest, AbstractWeightedMultisigIsmTest)
        returns (bytes memory)
    {
        return AbstractWeightedMultisigIsmTest.getMetadata(m, n, seed, message);
    }

    function _initializeIsm(
        IWeightedMultisigIsm.ValidatorInfo[] memory validators,
        uint96 threshold
    ) internal override returns (address) {
        weightedIsm = new MerkleRootWeightedMultisigIsm();
        weightedIsm.initialize(address(this), validators, threshold);
        return address(weightedIsm);
    }
}

contract MessageIdWeightedMultisigIsmTest is
    MessageIdMultisigIsmTest,
    AbstractWeightedMultisigIsmTest
{
    function setUp() public override {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

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
        override(AbstractMultisigIsmTest, AbstractWeightedMultisigIsmTest)
        returns (bytes memory)
    {
        return AbstractWeightedMultisigIsmTest.getMetadata(m, n, seed, message);
    }

    function _initializeIsm(
        IWeightedMultisigIsm.ValidatorInfo[] memory validators,
        uint96 threshold
    ) internal override returns (address) {
        weightedIsm = new MessageIdWeightedMultisigIsm();
        weightedIsm.initialize(address(this), validators, threshold);
        return address(weightedIsm);
    }
}
