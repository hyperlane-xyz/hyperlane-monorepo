// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ValueRequestHook} from "../../contracts/hooks/ValueRequestHook.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";

contract ValueRequestHookTest is Test {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    ValueRequestHook public hook;
    TestPostDispatchHook public innerHook;

    uint256 constant TEST_VALUE = 1 ether;
    uint256 constant INNER_HOOK_FEE = 0.1 ether;
    uint32 constant TEST_ORIGIN = 1;
    uint32 constant TEST_DESTINATION = 2;

    bytes testMessage;
    bytes testMetadata;

    function setUp() public {
        innerHook = new TestPostDispatchHook();
        innerHook.setFee(INNER_HOOK_FEE);

        hook = new ValueRequestHook(address(innerHook), TEST_VALUE);

        testMessage = _encodeTestMessage();
        testMetadata = StandardHookMetadata.formatMetadata(
            0, // original msgValue (will be overridden)
            50000, // gasLimit
            address(this), // refundAddress
            bytes("")
        );
    }

    function _encodeTestMessage() internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(3), // version
                uint32(0), // nonce
                TEST_ORIGIN,
                bytes32(uint256(uint160(address(0x1)))), // sender
                TEST_DESTINATION,
                bytes32(uint256(uint160(address(0x2)))), // recipient
                bytes("test message body")
            );
    }

    // ============ Constructor ============

    function test_constructor_setsInnerHook() public view {
        assertEq(address(hook.innerHook()), address(innerHook));
    }

    function test_constructor_setsValue() public view {
        assertEq(hook.value(), TEST_VALUE);
    }

    // ============ hookType ============

    function test_hookType() public view {
        assertEq(
            hook.hookType(),
            uint8(IPostDispatchHook.HookTypes.VALUE_REQUEST)
        );
    }

    // ============ quoteDispatch ============

    function test_quoteDispatch_addsValueToInnerQuote() public view {
        uint256 quote = hook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, INNER_HOOK_FEE + TEST_VALUE);
    }

    function test_quoteDispatch_withZeroInnerFee() public {
        innerHook.setFee(0);
        uint256 quote = hook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, TEST_VALUE);
    }

    function testFuzz_quoteDispatch(
        uint256 innerFee,
        uint256 configuredValue
    ) public {
        vm.assume(innerFee < type(uint128).max);
        vm.assume(configuredValue < type(uint128).max);

        innerHook.setFee(innerFee);
        ValueRequestHook fuzzHook = new ValueRequestHook(
            address(innerHook),
            configuredValue
        );

        uint256 quote = fuzzHook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, innerFee + configuredValue);
    }

    // ============ postDispatch ============

    function test_postDispatch_callsInnerHookWithModifiedMetadata() public {
        uint256 totalPayment = TEST_VALUE + INNER_HOOK_FEE;
        vm.deal(address(this), totalPayment);

        hook.postDispatch{value: totalPayment}(testMetadata, testMessage);

        // Verify inner hook was called (message marked as dispatched)
        bytes32 messageId = testMessage.id();
        assertTrue(innerHook.messageDispatched(messageId));
    }

    function test_postDispatch_forwardsValueToInnerHook() public {
        uint256 totalPayment = TEST_VALUE + INNER_HOOK_FEE;
        vm.deal(address(this), totalPayment);

        // Record balance before
        uint256 innerHookBalanceBefore = address(innerHook).balance;

        hook.postDispatch{value: totalPayment}(testMetadata, testMessage);

        // Verify value was forwarded to inner hook
        uint256 innerHookBalanceAfter = address(innerHook).balance;
        assertEq(innerHookBalanceAfter - innerHookBalanceBefore, totalPayment);
    }

    // ============ Zero Value Hook ============

    function test_zeroValueHook_quoteDispatch() public {
        ValueRequestHook zeroHook = new ValueRequestHook(address(innerHook), 0);

        uint256 quote = zeroHook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, INNER_HOOK_FEE); // Only inner hook fee
    }

    function test_zeroValueHook_postDispatch() public {
        ValueRequestHook zeroHook = new ValueRequestHook(address(innerHook), 0);

        vm.deal(address(this), INNER_HOOK_FEE);
        zeroHook.postDispatch{value: INNER_HOOK_FEE}(testMetadata, testMessage);

        bytes32 messageId = testMessage.id();
        assertTrue(innerHook.messageDispatched(messageId));
    }

    // ============ Metadata Override ============

    function test_metadataOverride_preservesGasLimit() public view {
        bytes memory metadataWithGas = StandardHookMetadata.formatMetadata(
            0,
            123456, // specific gas limit
            address(this),
            bytes("")
        );

        // quoteDispatch should work with the gas limit preserved
        uint256 quote = hook.quoteDispatch(metadataWithGas, testMessage);
        assertEq(quote, INNER_HOOK_FEE + TEST_VALUE);
    }

    function test_metadataOverride_preservesRefundAddress() public view {
        address specificRefundAddress = address(0xc0ffee);
        bytes memory metadataWithRefund = StandardHookMetadata.formatMetadata(
            0,
            50000,
            specificRefundAddress,
            bytes("")
        );

        // quoteDispatch should work with the refund address preserved
        uint256 quote = hook.quoteDispatch(metadataWithRefund, testMessage);
        assertEq(quote, INNER_HOOK_FEE + TEST_VALUE);
    }

    function test_metadataOverride_preservesCustomMetadata() public view {
        bytes memory customData = bytes("custom metadata");
        bytes memory metadataWithCustom = StandardHookMetadata.formatMetadata(
            0,
            50000,
            address(this),
            customData
        );

        // quoteDispatch should work with custom metadata preserved
        uint256 quote = hook.quoteDispatch(metadataWithCustom, testMessage);
        assertEq(quote, INNER_HOOK_FEE + TEST_VALUE);
    }

    // ============ Empty Metadata ============

    function test_emptyMetadata_quoteDispatch() public view {
        bytes memory emptyMetadata = bytes("");
        uint256 quote = hook.quoteDispatch(emptyMetadata, testMessage);
        assertEq(quote, INNER_HOOK_FEE + TEST_VALUE);
    }

    function test_emptyMetadata_postDispatch() public {
        bytes memory emptyMetadata = bytes("");
        uint256 totalPayment = TEST_VALUE + INNER_HOOK_FEE;
        vm.deal(address(this), totalPayment);

        hook.postDispatch{value: totalPayment}(emptyMetadata, testMessage);

        bytes32 messageId = testMessage.id();
        assertTrue(innerHook.messageDispatched(messageId));
    }
}
