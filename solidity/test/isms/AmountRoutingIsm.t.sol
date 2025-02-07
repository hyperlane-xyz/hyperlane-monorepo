// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestIsm} from "../../contracts/test/TestIsm.sol";
import {AmountRoutingIsm} from "../../contracts/isms/warp-route/AmountRoutingIsm.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

contract AmountRoutingIsmTest is Test {
    using TokenMessage for bytes;

    address private constant NON_OWNER =
        0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;
    AmountRoutingIsm internal ism;

    TestIsm internal lower;
    TestIsm internal upper;

    function setUp() public virtual {
        lower = new TestIsm();
        upper = new TestIsm();
        ism = new AmountRoutingIsm(
            address(lower),
            address(upper),
            type(uint256).max / 2
        );
    }

    function testRoute(
        bytes32 recipient,
        uint256 amount,
        bytes calldata data
    ) public {
        bytes memory headers = Message.formatMessage(
            uint8(0),
            uint32(0),
            uint32(0),
            bytes32(0),
            uint32(0),
            bytes32(0),
            bytes(data[0:0])
        );

        bytes memory body = TokenMessage.format(recipient, amount, data[0:0]);
        bytes memory message = abi.encodePacked(headers, body);

        IInterchainSecurityModule route = ism.route(message);
        if (amount >= ism.threshold()) {
            assertEq(address(route), address(upper));
        } else {
            assertEq(address(route), address(lower));
        }
    }
}
