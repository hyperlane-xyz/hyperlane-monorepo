// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {InterchainAccountMirror} from "./InterchainAccountMirror.sol";
import {InterchainAccountRouter} from "./InterchainAccountRouter.sol";

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

contract InterchainAccountMirrorFactory {
    InterchainAccountRouter immutable icaRouter;

    event InterchainAccountMirrorDeployed(
        address indexed owner,
        uint32 indexed destination,
        address indexed target,
        address mirror
    );

    constructor(address _icaRouter) {
        icaRouter = InterchainAccountRouter(_icaRouter);
    }

    function mirror(
        uint32 destination,
        address target
    ) external returns (address mirror) {
        bytes32 salt = keccak256(
            abi.encodePacked(msg.sender, destination, target)
        );
        mirror = address(
            new InterchainAccountMirror{salt: salt}(
                msg.sender,
                destination,
                target,
                icaRouter
            )
        );
        emit InterchainAccountMirrorDeployed(
            msg.sender,
            destination,
            target,
            mirror
        );
    }
}
