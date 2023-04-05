// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsmFactory.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MOfNTestUtils} from "./MOfNTestUtils.sol";

contract MultisigIsmTest is Test {
    uint32 constant ORIGIN = 11;
    StaticMultisigIsmFactory factory;
    IMultisigIsm ism;
    TestMailbox mailbox;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
        factory = new StaticMultisigIsmFactory();
    }

    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (uint256[] memory) {
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
        bytes memory body
    ) internal returns (bytes memory) {
        uint8 version = mailbox.VERSION();
        uint32 origin = mailbox.localDomain();
        bytes32 sender = TypeCasts.addressToBytes32(address(this));
        uint32 nonce = mailbox.count();
        mailbox.dispatch(destination, recipient, body);
        return
            Message.formatMessage(
                version,
                nonce,
                origin,
                sender,
                destination,
                recipient,
                body
            );
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) private returns (bytes memory) {
        uint32 domain = mailbox.localDomain();
        uint256[] memory keys = addValidators(m, n, seed);
        uint256[] memory signers = MOfNTestUtils.choose(m, keys, seed);
        bytes32 mailboxAsBytes32 = TypeCasts.addressToBytes32(address(mailbox));
        bytes32 checkpointRoot = mailbox.root();
        uint32 checkpointIndex = uint32(mailbox.count() - 1);
        bytes memory metadata = abi.encodePacked(
            checkpointRoot,
            checkpointIndex,
            mailboxAsBytes32,
            mailbox.proof()
        );
        bytes32 digest = CheckpointLib.digest(
            domain,
            mailboxAsBytes32,
            checkpointRoot,
            checkpointIndex
        );
        for (uint256 i = 0; i < signers.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);
            metadata = abi.encodePacked(metadata, r, s, v);
        }
        return metadata;
    }

    function testVerify() public {
        // logs do not work with fuzzing ??
        // https://github.com/foundry-rs/foundry/issues/3843

        bytes32 seed = keccak256("");
        uint32 destination = ORIGIN + 1;
        bytes32 recipient = keccak256("recipient");
        bytes memory body = "body";
        bytes memory message = getMessage(destination, recipient, body);

        uint8 MAX_VALIDATOR_COUNT = 18;

        for (
            uint8 numValidators = 1;
            numValidators <= MAX_VALIDATOR_COUNT;
            numValidators++
        ) {
            emit log_named_uint("numValidators", numValidators);

            for (uint8 threshold = 1; threshold <= numValidators; threshold++) {
                emit log_named_uint("threshold", threshold);

                bytes memory metadata = getMetadata(
                    threshold,
                    numValidators,
                    seed
                );

                // does not correctly account for memory expansion costs
                uint256 gas = gasleft();
                assertTrue(ism.verify(metadata, message));
                gas = gas - gasleft();

                emit log_named_uint("gas", gas);
                console.log(" ");
            }
            console.log(" ");
        }
    }
}
