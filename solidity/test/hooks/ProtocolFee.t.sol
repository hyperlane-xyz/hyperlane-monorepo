// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {ProtocolFee} from "../../contracts/hooks/ProtocolFee.sol";

contract ProtocolFeeTest is Test {
    using TypeCasts for address;

    ProtocolFee internal fees;

    address internal alice = address(address(this)); // alice the user
    address internal bob = address(0x2); // bob the beneficiary
    address internal charlie = address(0x3); // charlie the crock

    uint32 internal constant TEST_ORIGIN_DOMAIN = 1;
    uint32 internal constant TEST_DESTINATION_DOMAIN = 2;

    uint256 internal constant MAX_FEE = 1e16;
    uint256 internal constant FEE = 1e16;

    bytes internal testMessage;

    function setUp() public {
        fees = new ProtocolFee(MAX_FEE, FEE, bob, address(this));

        testMessage = _encodeTestMessage();
    }

    function testConstructor() public {
        assertEq(fees.protocolFee(), FEE);
    }

    function testHookType() public {
        assertEq(fees.hookType(), uint8(IPostDispatchHook.Types.PROTOCOL_FEE));
    }

    function testSetProtocolFee(uint256 fee) public {
        fee = bound(fee, 0, fees.MAX_PROTOCOL_FEE());

        vm.expectEmit(true, true, true, true);
        emit ProtocolFee.ProtocolFeeSet(fee);
        fees.setProtocolFee(fee);
        assertEq(fees.protocolFee(), fee);
    }

    function testSetProtocolFee_revertsWhen_notOwner() public {
        uint256 fee = 1e17;

        vm.prank(charlie);
        vm.expectRevert("Ownable: caller is not the owner");
        fees.setProtocolFee(fee);

        assertEq(fees.protocolFee(), FEE);
    }

    function testSetProtocolFee_revertWhen_exceedsMax(uint256 fee) public {
        fee = bound(
            fee,
            fees.MAX_PROTOCOL_FEE() + 1,
            10 * fees.MAX_PROTOCOL_FEE()
        );

        vm.expectRevert("ProtocolFee: exceeds max protocol fee");
        fees.setProtocolFee(fee);

        assertEq(fees.protocolFee(), FEE);
    }

    function testSetBeneficiary(address beneficiary) public {
        vm.assume(beneficiary != address(0));
        vm.expectEmit(true, true, true, true);
        emit ProtocolFee.BeneficiarySet(beneficiary);
        fees.setBeneficiary(beneficiary);
        assertEq(fees.beneficiary(), beneficiary);
    }

    function testSetBeneficiary_revertWhen_notOwner() public {
        vm.prank(charlie);

        vm.expectRevert("Ownable: caller is not the owner");
        fees.setBeneficiary(charlie);
        assertEq(fees.beneficiary(), bob);
    }

    function testQuoteDispatch() public {
        assertEq(fees.quoteDispatch("", testMessage), FEE);
    }

    function testFuzz_postDispatch_inusfficientFees(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        // bound feeSent to be less than feeRequired
        feeSent = bound(feeSent, 0, feeRequired - 1);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        vm.expectRevert("ProtocolFee: insufficient protocol fee");
        fees.postDispatch{value: feeSent}("", "");

        assertEq(alice.balance, balanceBefore);
    }

    function testFuzz_postDispatch_sufficientFees(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        feeSent = bound(feeSent, feeRequired, 10 * feeRequired);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);
        uint256 aliceBalanceBefore = alice.balance;

        vm.prank(alice);
        fees.postDispatch{value: feeSent}("", testMessage);

        assertEq(alice.balance, aliceBalanceBefore - feeRequired);
    }

    function test_postDispatch_specifyRefundAddress(
        uint256 feeRequired,
        uint256 feeSent
    ) public {
        bytes memory metadata = StandardHookMetadata.overrideRefundAddress(bob);

        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        feeSent = bound(feeSent, feeRequired, 10 * feeRequired);
        vm.deal(alice, feeSent);

        fees.setProtocolFee(feeRequired);
        uint256 aliceBalanceBefore = alice.balance;
        uint256 bobBalanceBefore = bob.balance;
        vm.prank(alice);

        fees.postDispatch{value: feeSent}(metadata, testMessage);

        assertEq(alice.balance, aliceBalanceBefore - feeSent);
        assertEq(bob.balance, bobBalanceBefore + feeSent - feeRequired);
    }

    function testFuzz_collectProtocolFee(
        uint256 feeRequired,
        uint256 dispatchCalls
    ) public {
        feeRequired = bound(feeRequired, 1, fees.MAX_PROTOCOL_FEE());
        // no of postDispatch calls to be made
        dispatchCalls = bound(dispatchCalls, 1, 1000);
        vm.deal(alice, feeRequired * dispatchCalls);

        fees.setProtocolFee(feeRequired);

        uint256 balanceBefore = bob.balance;

        for (uint256 i = 0; i < dispatchCalls; i++) {
            vm.prank(alice);
            fees.postDispatch{value: feeRequired}("", "");
        }

        fees.collectProtocolFees();

        assertEq(bob.balance, balanceBefore + feeRequired * dispatchCalls);
    }

    // ============ Helper Functions ============

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                uint8(0),
                uint32(1),
                TEST_ORIGIN_DOMAIN,
                alice.addressToBytes32(),
                TEST_DESTINATION_DOMAIN,
                alice.addressToBytes32(),
                abi.encodePacked("Hello World")
            );
    }

    receive() external payable {}
}
