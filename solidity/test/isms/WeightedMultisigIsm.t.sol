// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IWeightedMultisigIsm} from "../../contracts/interfaces/isms/IWeightedMultisigIsm.sol";
import {MessageIdWeightedMultisigIsm} from "../../contracts/isms/multisig/WeightedMultisigIsm.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {AbstractWeightedMultisigIsm} from "../../contracts/isms/multisig/AbstractWeightedMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

import {AbstractMultisigIsmTest, MessageIdMultisigIsmTest} from "./MultisigIsm.t.sol";

abstract contract AbstractWeightedMultisigIsmTest is AbstractMultisigIsmTest {
    using Message for bytes;
    using TypeCasts for address;

    AbstractWeightedMultisigIsm weightedIsm;

    uint96 public constant BASIS_POINTS = 10000;

    function addValidators(
        uint8 n,
        bytes32 seed
    ) internal returns (IWeightedMultisigIsm.ValidatorInfo[] memory) {
        // vm.assume(BASIS_POINTS % n == 0);
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
                ) % remainingWeight) + 1;

                validators[i].weight = uint96(weight);
                remainingWeight -= weight;
            }
        }
        weightedIsm = new MessageIdWeightedMultisigIsm();
        weightedIsm.initialize(address(this), validators, 6666);
        ism = IInterchainSecurityModule(address(weightedIsm));
        return validators;
    }

    function getMetadata(
        uint8,
        /*m*/ uint8 n,
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

        IWeightedMultisigIsm.ValidatorInfo[]
            memory allValidators = addValidators(n, seed);
        uint96 thresholdWeight = weightedIsm.thresholdWeight();

        bytes memory metadata = metadataPrefix(message);
        fixtureInit();

        uint96 totalWeight = 0;
        uint256 signerCount = 0;

        while (
            totalWeight < thresholdWeight && signerCount < allValidators.length
        ) {
            console.log("signing key: ", allValidators[signerCount].signingKey);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(
                allValidators[signerCount].signingKey,
                digest
            );
            console.logBytes(metadata);
            metadata = abi.encodePacked(metadata, r, s, v);

            fixtureAppendSignature(signerCount, v, r, s);

            totalWeight += allValidators[signerCount].weight;
            signerCount++;
        }

        writeFixture(metadata, uint8(signerCount), n);

        return metadata;
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

        // factory = new StaticMessageIdMultisigIsmFactory();
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
}
