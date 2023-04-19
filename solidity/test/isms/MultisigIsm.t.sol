// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "forge-std/StdJson.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IMultisigIsm} from "../../contracts/interfaces/isms/IMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {StaticMultisigIsmFactory} from "../../contracts/isms/multisig/StaticMultisigIsmFactory.sol";
import {CheckpointLib} from "../../contracts/libs/CheckpointLib.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MOfNTestUtils} from "./IsmTestUtils.sol";

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

    using stdJson for string;

    function testVerify() public {
        // logs do not work with fuzzing ??
        // https://github.com/foundry-rs/foundry/issues/3843

        bytes32 seed = keccak256("");
        uint32 destination = ORIGIN + 1;
        bytes32 recipient = keccak256("recipient");

        uint256 MAX_MESSAGE_BODY_BYTES = 2 * 2**10;
        bytes memory body = "";
        for (uint256 i = 0; i < MAX_MESSAGE_BODY_BYTES; i++) {
            body = abi.encodePacked(body, uint8(0xAA));
        }

        bytes memory message = getMessage(destination, recipient, body);

        uint8 MAX_VALIDATOR_COUNT = 18;

        // To write:
        // ```
        // using stdJson for string;
        // string memory json = "deploymentArtifact";
        // Contract contract = new Contract();
        // json.serialize("contractAddress", address(contract));
        // json = json.serialize("deploymentTimes", uint(1));
        // // store the stringified JSON to the 'json' variable we have been using as a key
        // // as we won't need it any longer
        // string memory json2 = "finalArtifact";
        // string memory final = json2.serialize("depArtifact", json);
        // final.write("<some_path>");
        // ```

        string memory json = "gasInstrumentation";

        for (
            uint8 numValidators = 1;
            numValidators <= MAX_VALIDATOR_COUNT;
            numValidators++
        ) {
            string memory json2 = "numValidators";

            for (uint8 threshold = 1; threshold <= numValidators; threshold++) {
                string memory json3 = "threshold";

                bytes memory metadata = getMetadata(
                    threshold,
                    numValidators,
                    seed
                );

                // does not correctly account for memory expansion costs
                uint256 verify = gasleft();
                assertTrue(ism.verify(metadata, message));
                verify = verify - gasleft();
                json3.serialize("verify", verify);

                uint256 merkle = gasleft();
                assertTrue(ism.verifyMerkleProof(metadata, message));
                merkle = merkle - gasleft();
                json3.serialize("merkle", merkle);

                uint256 signatures = gasleft();
                assertTrue(ism.verifyValidatorSignaturs(metadata, message));
                signatures = signatures - gasleft();
                json3.serialize("signatures", signatures);

                json2.serialize(Strings.toString(threshold), json3);
            }

            json.serialize(Strings.toString(numValidators), json2);
        }

        json.write("gasInstrumentation.json");
    }
}
