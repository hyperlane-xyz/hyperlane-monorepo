// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {StaticInterchainGasPaymaster} from "../../contracts/igps/StaticInterchainGasPaymaster.sol";

contract StaticInterchainGasPaymasterTest is Test {
    StaticInterchainGasPaymaster igp;

    uint32 constant testDestinationDomain = 11111;
    uint256 constant testGasAmount = 300000;
    bytes32 constant testMessageId =
        0x6ae9a99190641b9ed0c07143340612dde0e9cb7deaa5fe07597858ae9ba5fd7f;
    address constant testRefundAddress = address(0xc0ffee);

    event GasPayment(
        bytes32 indexed messageId,
        uint256 gasAmount,
        uint256 payment
    );

    function setUp() public {
        igp = new StaticInterchainGasPaymaster();
    }

    // ============ payForGas ============

    function testPayForGas() public {
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasAmount
        );
        assertEq(_quote, 1);
        vm.expectEmit(true, true, false, true);
        emit GasPayment(testMessageId, testGasAmount, _quote);
        igp.payForGas{value: _quote}(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
            testRefundAddress
        );
    }
}
