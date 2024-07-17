// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IWeightedMultisigIsm} from "../../contracts/interfaces/isms/IWeightedMultisigIsm.sol";
import {MessageIdWeightedMultisigIsm} from "../../contracts/isms/multisig/WeightedMultisigIsm.sol";
import {AbstractWeightedMultisigIsm} from "../../contracts/isms/multisig/AbstractWeightedMultisigIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestMerkleTreeHook} from "../../contracts/test/TestMerkleTreeHook.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

import {MessageIdMultisigIsmTest} from "./MultisigIsm.t.sol";

contract MessageIdWeightedMultisigIsmTest is MessageIdMultisigIsmTest {
    function addValidators(
        uint8 m,
        uint8 n,
        bytes32 seed
    ) internal override returns (uint256[] memory) {
        uint256[] memory keys = new uint256[](n);
        IWeightedMultisigIsm.ValidatorInfo[]
            memory validators = new IWeightedMultisigIsm.ValidatorInfo[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 key = uint256(keccak256(abi.encode(seed, i)));
            keys[i] = key;
            validators[i].signingKey = vm.addr(key);
            validators[i].weight = 1;
        }
        ism = new MessageIdWeightedMultisigIsm();
        AbstractWeightedMultisigIsm(ism).initialize(
            address(this),
            validators,
            m
        );
        return keys;
    }

    function setUp() public override {
        mailbox = new TestMailbox(ORIGIN);
        merkleTreeHook = new TestMerkleTreeHook(address(mailbox));
        noopHook = new TestPostDispatchHook();

        // factory = new StaticMessageIdMultisigIsmFactory();
        mailbox.setDefaultHook(address(merkleTreeHook));
        mailbox.setRequiredHook(address(noopHook));
    }
}
