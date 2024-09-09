// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {InterchainAccountMirror} from "./InterchainAccountMirror.sol";
import {InterchainAccountRouter} from "./InterchainAccountRouter.sol";

// ============ External Imports ============
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

contract InterchainAccountMirrorFactory {
    InterchainAccountRouter immutable icaRouter;

    event InterchainAccountMirrorDeployed(
        uint32 indexed destination,
        bytes32 indexed target,
        address indexed owner,
        address mirror
    );

    constructor(address _icaRouter) {
        icaRouter = InterchainAccountRouter(_icaRouter);
    }

    function deployMirror(
        address owner,
        uint32 destination,
        bytes32 target
    ) external returns (address payable mirror) {
        bytes32 salt = keccak256(abi.encodePacked(owner, destination, target));
        mirror = payable(
            new InterchainAccountMirror{salt: salt}(
                icaRouter,
                destination,
                target,
                owner
            )
        );
        emit InterchainAccountMirrorDeployed(
            destination,
            target,
            owner,
            mirror
        );
    }
}
