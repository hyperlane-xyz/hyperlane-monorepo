// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {InterchainAccountMirrorCalldata} from "../contracts/middleware/libs/InterchainAccountMirrorCalldata.sol";
import {InterchainAccountMirror} from "../contracts/middleware/InterchainAccountMirror.sol";
import {InterchainAccountMirrorFactory} from "../contracts/middleware/InterchainAccountMirrorFactory.sol";
import {InterchainAccountRouter} from "../contracts/middleware/InterchainAccountRouter.sol";
import {CallLib} from "../contracts/middleware/libs/Call.sol";

contract InterchainAccountMirrorTest is Test {
    event InterchainAccountMirrorDeployed(
        uint32 indexed destination,
        bytes32 indexed target,
        address indexed owner,
        address mirror
    );

    address icaRouter = address(0x32);

    InterchainAccountMirrorFactory icaMirrorFactory;

    function setUp() public {
        icaMirrorFactory = new InterchainAccountMirrorFactory(icaRouter);
    }

    function test(
        address owner,
        bytes calldata data,
        uint256 value,
        uint32 destination,
        bytes32 target,
        bytes32 destinationIcaRouter,
        bytes32 destinationIsmAddress
    ) public payable {
        // do not match against fourth argument (mirror address)
        vm.expectEmit(true, true, true, false);
        emit InterchainAccountMirrorDeployed(
            destination,
            target,
            owner,
            address(0x0) // no need to assert CREATE2 derivation correctness
        );
        address payable mirror = icaMirrorFactory.deployMirror(
            owner,
            destination,
            target
        );

        // EvmError: Create Collision
        vm.expectRevert();
        icaMirrorFactory.deployMirror(owner, destination, target);

        bytes memory callData = InterchainAccountMirrorCalldata.encode(
            data,
            value,
            destinationIcaRouter,
            destinationIsmAddress
        );

        vm.expectRevert("InterchainAccountMirror: only owner");
        mirror.call(callData);

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.Call(target, value, data);

        bytes memory expectedCallData = abi.encodeWithSignature(
            "callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[])",
            destination,
            destinationIcaRouter,
            destinationIsmAddress,
            calls
        );
        vm.prank(owner);
        vm.expectCall(icaRouter, msg.value, expectedCallData);
        mirror.call{value: msg.value}(callData);
    }
}
