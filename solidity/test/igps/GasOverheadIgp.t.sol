// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {GasOverheadIgp} from "../../contracts/igps/GasOverheadIgp.sol";
import {InterchainGasPaymaster} from "../../contracts/igps/InterchainGasPaymaster.sol";

contract GasOverheadIgpTest is Test {
    GasOverheadIgp igp;

    InterchainGasPaymaster innerIgp;

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
        innerIgp = new InterchainGasPaymaster();
        igp = new GasOverheadIgp(address(innerIgp));
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
        uint32[] memory _domains = new uint32[](2);
        _domains[0] = testDestinationDomain;
        _domains[1] = 4321;
        uint256[] memory _gasOverheads = new uint256[](2);
        _gasOverheads[0] = testGasOverhead;
        _gasOverheads[1] = 432100;

        // Topic 0 = event signature
        // Topic 1 = indexed domain
        // Topic 2 = not set
        // Data = gas amount
        vm.expectEmit(true, true, false, true);
        emit DestinationGasOverheadSet(_domains[0], _gasOverheads[0]);
        vm.expectEmit(true, true, false, true);
        emit DestinationGasOverheadSet(_domains[1], _gasOverheads[1]);

        igp.setDestinationGasOverheads(_domains, _gasOverheads);
    }

    function testSetDestinationGasAmountsIncorrectLengths() public {
        // length of 2
        uint32[] memory _domains = new uint32[](2);
        _domains[0] = testDestinationDomain;
        _domains[1] = 4321;
        // length of 1
        uint256[] memory _gasOverheads = new uint256[](1);
        _gasOverheads[0] = testGasOverhead;

        vm.expectRevert(bytes("Domain and gas overhead length mismatch"));
        igp.setDestinationGasOverheads(_domains, _gasOverheads);
    }

    function testSetDestinationGasAmountsNotOwner() public {
        uint32[] memory _domains = new uint32[](1);
        _domains[0] = testDestinationDomain;
        uint256[] memory _gasOverheads = new uint256[](1);
        _gasOverheads[0] = testGasOverhead;

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(nonOwner);
        igp.setDestinationGasOverheads(_domains, _gasOverheads);
    }

    function setInnerIgp() public {
        address newInnerIgp = 0xFAcefaCEFACefACeFaCefacEFaCeFACEFAceFAcE;
        // Only concerned about topic 0 (event signature) and the data.
        vm.expectEmit(true, false, false, true);
        emit InnerIgpSet(newInnerIgp);

        igp.setInnerIgp(newInnerIgp);
    }

    function setInnerIgpNotOwner() public {
        address newInnerIgp = 0xFAcefaCEFACefACeFaCefacEFaCeFACEFAceFAcE;

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(nonOwner);
        igp.setInnerIgp(newInnerIgp);
    }

    // ============ Helper Functions ============

    function setTestDestinationGasOverhead() internal {
        uint32[] memory _domains = new uint32[](1);
        _domains[0] = testDestinationDomain;
        uint256[] memory _gasOverheads = new uint256[](1);
        _gasOverheads[0] = testGasOverhead;
        igp.setDestinationGasOverheads(_domains, _gasOverheads);
    }
}
