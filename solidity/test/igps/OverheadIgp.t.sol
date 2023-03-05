// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {OverheadIgp} from "../../contracts/igps/OverheadIgp.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";

contract OverheadIgpTest is Test {
    OverheadIgp igp;

    TestInterchainGasPaymaster innerIgp;

    bytes32 constant testMessageId =
        bytes32(
            0xf00000000000000000000000000000000000000000000000000000000000000f
        );
    uint32 constant testDestinationDomain = 1234;
    uint256 constant testGasOverhead = 123000;
    uint256 constant testGasAmount = 50000;

    address constant nonOwner = 0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;

    event InnerIgpSet(address innerIgp);
    event DestinationGasOverheadSet(uint32 indexed domain, uint256 gasOverhead);

    function setUp() public {
        innerIgp = new TestInterchainGasPaymaster(address(this));
        igp = new OverheadIgp(address(innerIgp));
    }

    function testInnerIgpSet() public {
        assertEq(address(igp.innerIgp()), address(innerIgp));
    }

    function testPayForGas() public {
        setTestDestinationGasOverhead();

        uint256 testPayment = 123456789;

        vm.expectCall(
            address(innerIgp),
            testPayment,
            abi.encodeCall(
                innerIgp.payForGas,
                (
                    testMessageId,
                    testDestinationDomain,
                    testGasOverhead + testGasAmount,
                    msg.sender
                )
            )
        );

        igp.payForGas{value: testPayment}(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
            msg.sender
        );
    }

    function testQuoteGasPayment() public {
        setTestDestinationGasOverhead();

        vm.expectCall(
            address(innerIgp),
            abi.encodeCall(
                innerIgp.quoteGasPayment,
                (testDestinationDomain, testGasOverhead + testGasAmount)
            )
        );

        igp.quoteGasPayment(testDestinationDomain, testGasAmount);
    }

    function testDestinationGasAmount() public {
        setTestDestinationGasOverhead();

        assertEq(
            igp.destinationGasAmount(testDestinationDomain, testGasAmount),
            testGasOverhead + testGasAmount
        );
    }

    // Test that it doesn't revert, and just doesn't add any value to the
    // provided gas amount
    function testDestinationGasAmountWhenOverheadNotSet() public {
        assertEq(
            igp.destinationGasAmount(testDestinationDomain, testGasAmount),
            testGasAmount
        );
    }

    function testSetDestinationGasAmounts() public {
        OverheadIgp.DomainConfig[]
            memory configs = new OverheadIgp.DomainConfig[](2);
        configs[0] = OverheadIgp.DomainConfig(
            testDestinationDomain,
            testGasOverhead
        );
        configs[1] = OverheadIgp.DomainConfig(4321, 432100);

        // Topic 0 = event signature
        // Topic 1 = indexed domain
        // Topic 2 = not set
        // Data = gas amount
        vm.expectEmit(true, true, false, true);
        emit DestinationGasOverheadSet(
            configs[0].domain,
            configs[0].gasOverhead
        );
        vm.expectEmit(true, true, false, true);
        emit DestinationGasOverheadSet(
            configs[1].domain,
            configs[1].gasOverhead
        );

        igp.setDestinationGasOverheads(configs);
    }

    function testSetDestinationGasAmountsNotOwner() public {
        OverheadIgp.DomainConfig[]
            memory configs = new OverheadIgp.DomainConfig[](2);
        configs[0] = OverheadIgp.DomainConfig(
            testDestinationDomain,
            testGasOverhead
        );
        configs[1] = OverheadIgp.DomainConfig(4321, 432100);

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(nonOwner);
        igp.setDestinationGasOverheads(configs);
    }

    // ============ Helper Functions ============

    function setTestDestinationGasOverhead() internal {
        OverheadIgp.DomainConfig[]
            memory configs = new OverheadIgp.DomainConfig[](1);
        configs[0] = OverheadIgp.DomainConfig(
            testDestinationDomain,
            testGasOverhead
        );
        igp.setDestinationGasOverheads(configs);
    }
}
