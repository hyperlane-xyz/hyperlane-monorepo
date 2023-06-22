// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {MultisigCcipReadIsm} from "../../contracts/isms/ccip-read/MultisigCcipReadIsm.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MOfNTestUtils} from "./IsmTestUtils.sol";

contract MultisigCcipReadIsmTest is Test {
    using Message for bytes;

    uint32 constant ORIGIN = 11;
    MultisigCcipReadIsm ism;
    TestMailbox mailbox;

    using Message for bytes;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN);
    }

    function getMetadata(
        uint8 m,
        uint8 n,
        bytes32 seed,
        bytes memory body
    ) internal returns (bytes memory) {
        uint256[] memory keys = addValidators(m, n, seed);
        uint256[] memory signers = MOfNTestUtils.choose(m, keys, seed);

        bytes32 digest = keccak256(body);
        bytes memory metadata = abi.encodePacked(
            TypeCasts.addressToBytes32(address(mailbox)),
            uint8(m)
        );
        for (uint256 i = 0; i < m; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(signers[i], digest);
            metadata = bytes.concat(metadata, abi.encodePacked(r, s, v));
        }

        address[] memory validatorAddresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            validatorAddresses[i] = vm.addr(keys[i]);
        }

        return bytes.concat(metadata, abi.encodePacked(validatorAddresses));
    }

    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal returns (uint256[] memory) {
        uint32[] memory domains = new uint32[](1);
        domains[0] = ORIGIN;
        uint256[] memory keys = new uint256[](n);
        address[] memory addresses = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            addresses[i] = vm.addr(key);
        }
        ism = new MultisigCcipReadIsm();

        address[][] memory wrapped = new address[][](1);
        wrapped[0] = addresses;
        ism.enrollValidators(domains, wrapped);
        ism.setThreshold(ORIGIN, m);
        return keys;
    }

    function getMessage(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body
    ) internal returns (bytes memory) {
        uint8 version = mailbox.VERSION();
        uint32 origin = mailbox.localDomain();
        bytes32 sender = TypeCasts.addressToBytes32(address(this));
        uint32 nonce = mailbox.count();
        mailbox.dispatch(destination, recipient, body);
        bytes memory message = Message.formatMessage(
            version,
            nonce,
            origin,
            sender,
            destination,
            recipient,
            body
        );
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
        vm.assume(0 < m && m <= n && n < 10 && 0 < body.length);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, body);
        assertTrue(ism.verify(metadata, message));
    }

    function testFailVerify(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        uint8 m,
        uint8 n,
        bytes32 seed
    ) public {
        vm.assume(0 < m && m <= n && n < 10 && 0 < body.length);
        bytes memory message = getMessage(destination, recipient, body);
        bytes memory metadata = getMetadata(m, n, seed, message);

        // changing single byte in metadata should fail signature verification
        uint256 index = uint256(seed) % metadata.length;
        metadata[index] = ~metadata[index];
        assertFalse(ism.verify(metadata, message));
    }
}
