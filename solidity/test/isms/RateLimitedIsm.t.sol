// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import {RateLimitedIsm} from "contracts/isms/warp-route/RateLimitedIsm.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

contract RateLimitedIsmTest is Test {
    using TypeCasts for address;

    uint256 MAX_CAPACITY = 1 ether;
    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    address WARP_ROUTE_ADDR = makeAddr("warpRoute");
    TestMailbox localMailbox;
    TestRecipient testRecipient;
    RateLimitedIsm rateLimitedIsm;

    function setUp() external {
        localMailbox = new TestMailbox(ORIGIN);

        rateLimitedIsm = new RateLimitedIsm(
            address(localMailbox),
            MAX_CAPACITY
        );
        testRecipient = new TestRecipient();

        testRecipient.setInterchainSecurityModule(address(rateLimitedIsm));
    }

    function testRateLimitedIsm_revertsIDeliveredFalse(
        bytes calldata _message
    ) external {
        vm.prank(address(localMailbox));
        vm.expectRevert("InvalidDeliveredMessage");
        rateLimitedIsm.verify(bytes(""), _message);
    }

    function testRateLimitedIsm_verify(uint128 _amount) external {
        vm.assume(_amount <= rateLimitedIsm.calculateCurrentLevel());

        vm.prank(address(localMailbox));
        localMailbox.process(bytes(""), _encodeTestMessage(_amount));
    }

    function testRateLimitedIsm_preventsDuplicateMessageFromValidating(
        uint128 _amount
    ) public {
        vm.assume(_amount <= rateLimitedIsm.calculateCurrentLevel());

        bytes memory encodedMessage = _encodeTestMessage(_amount);
        vm.prank(address(localMailbox));
        localMailbox.process(bytes(""), encodedMessage);

        vm.expectRevert("MessageAlreadyValidated");
        rateLimitedIsm.verify(bytes(""), encodedMessage);
    }

    function _encodeTestMessage(
        uint256 _amount
    ) internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                uint8(3),
                uint32(1),
                ORIGIN,
                WARP_ROUTE_ADDR.addressToBytes32(),
                ORIGIN,
                address(testRecipient).addressToBytes32(),
                TokenMessage.format(bytes32(""), _amount, bytes(""))
            );
    }
}
