// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {Message} from "../libs/Message.sol";
import {InterchainAccountMessage} from "./libs/InterchainAccountMessage.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract IcaCallCommitmentIsm is IInterchainSecurityModule, PackageVersioned {
    using InterchainAccountMessage for bytes;
    using TypeCasts for bytes32;

    uint8 public immutable moduleType = uint8(Types.NULL);

    function verify(
        bytes calldata /*_metadata*/,
        bytes calldata _message
    ) external view override returns (bool) {
        bytes calldata body = Message.body(_message);

        // sanity check that the ICA message has this ISM in the body
        assert(body.ism().bytes32ToAddress() == address(this));

        require(
            keccak256(body.callsRaw()) == body.salt(),
            "Salt does not match call commitment"
        );

        return true;
    }
}
