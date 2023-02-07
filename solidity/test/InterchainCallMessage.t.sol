// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/middleware/InterchainCallMessage.sol";
import "../contracts/libs/Call.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract InterchainCallMessageTest is Test {
    using CallLib for CallLib.Call[];
    using InterchainCallMessage for bytes;
    using TypeCasts for address;

    bytes32 sender = address(this).addressToBytes32();

    function decodeDefaultCalls(
        bytes calldata message,
        CallLib.Call[] calldata calls
    ) public {
        assertEq(message.sender(), sender, "!sender");
        assertTrue(
            message.calltype() == InterchainCallMessage.CallType.CALL,
            "!calltype"
        );
        assertEq(abi.encode(message.calls()), abi.encode(calls), "!calls");
    }

    function testDefaultCalls(CallLib.Call[] calldata calls) public {
        vm.assume(calls.length > 0);
        bytes memory message = InterchainCallMessage.format(calls, sender);
        InterchainCallMessageTest(this).decodeDefaultCalls(message, calls);
    }

    function decodeStaticCalls(
        bytes calldata message,
        CallLib.StaticCall[] calldata calls
    ) public {
        assertEq(message.sender(), sender, "!sender");
        assertTrue(
            message.calltype() == InterchainCallMessage.CallType.STATIC_CALL,
            "!calltype"
        );
        assertEq(abi.encode(message.calls()), abi.encode(calls), "!calls");
    }

    function testStaticCalls(CallLib.StaticCall[] calldata calls) public {
        vm.assume(calls.length > 0);
        bytes memory message = InterchainCallMessage.format(calls, sender);
        InterchainCallMessageTest(this).decodeStaticCalls(message, calls);
    }

    function decodeCallsWithCallback(
        bytes calldata message,
        CallLib.StaticCallWithCallback[] calldata calls
    ) public {
        assertEq(message.sender(), sender, "!sender");
        assertTrue(
            message.calltype() ==
                InterchainCallMessage.CallType.STATIC_CALL_WITH_CALLBACK,
            "!calltype"
        );
        assertEq(abi.encode(message.calls()), abi.encode(calls));
    }

    function testCallsWithCallback(
        CallLib.StaticCallWithCallback[] calldata calls
    ) public {
        vm.assume(calls.length > 0);
        bytes memory message = InterchainCallMessage.format(calls, sender);
        InterchainCallMessageTest(this).decodeCallsWithCallback(message, calls);
    }

    function decodeRawCalls(bytes calldata message, bytes[] calldata calls)
        public
    {
        assertEq(message.sender(), sender, "!sender");
        assertTrue(
            message.calltype() == InterchainCallMessage.CallType.RAW_CALLDATA,
            "!calltype"
        );
        assertEq(abi.encode(message.calls()), abi.encode(calls));
    }

    function testRawCalls(bytes[] calldata calls) public {
        vm.assume(calls.length > 0);
        bytes memory message = InterchainCallMessage.format(calls, sender);
        InterchainCallMessageTest(this).decodeRawCalls(message, calls);
    }
}
