// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

import {BaseFee, FeeType} from "../../contracts/token/fees/BaseFee.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {ProgressiveFee} from "../../contracts/token/fees/ProgressiveFee.sol";
import {RegressiveFee} from "../../contracts/token/fees/RegressiveFee.sol";
import {RoutingFee} from "../../contracts/token/fees/RoutingFee.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

// --- Base Test ---

abstract contract BaseFeeTest is Test {
    BaseFee public feeContract;
    address internal constant OWNER = address(0x123);
    address internal constant BENEFICIARY = address(0x456);

    ERC20Test token = new ERC20Test("Test Token", "TST", 0, 18);

    uint32 internal constant destination = 1;
    bytes32 internal constant recipient =
        bytes32(uint256(uint160(address(0x789))));

    function setUp() public virtual {
        vm.label(OWNER, "Owner");
        vm.label(BENEFICIARY, "Beneficiary");
    }

    function test_Claim() public virtual {
        // Test claiming ERC20 tokens
        uint256 erc20Amount = 100 * 10 ** 18;
        token.mintTo(address(feeContract), erc20Amount);

        uint256 beneficiaryErc20BalanceBefore = token.balanceOf(BENEFICIARY);
        vm.prank(OWNER);
        feeContract.claim(BENEFICIARY);
        uint256 beneficiaryErc20BalanceAfter = token.balanceOf(BENEFICIARY);

        assertEq(
            beneficiaryErc20BalanceAfter - beneficiaryErc20BalanceBefore,
            erc20Amount,
            "ERC20 claim failed"
        );
        assertEq(
            token.balanceOf(address(feeContract)),
            0,
            "ERC20 balance not zero after claim"
        );
    }
}

// --- LinearFee Tests ---

contract LinearFeeTest is BaseFeeTest {
    uint256 internal constant DEFAULT_MAX_FEE = 1000;
    uint256 internal constant DEFAULT_HALF_AMOUNT = 10000;

    function setUp() public override {
        super.setUp();
        feeContract = new LinearFee(
            address(token),
            DEFAULT_MAX_FEE,
            DEFAULT_HALF_AMOUNT,
            OWNER
        );
    }

    function test_LinearFee_Type() public {
        assertEq(uint(feeContract.feeType()), uint(FeeType.LINEAR));
    }

    function test_LinearFee_Quote(
        uint96 maxFee,
        uint96 halfAmount,
        uint96 amount
    ) public {
        vm.assume(maxFee > 0);
        vm.assume(halfAmount > 0);

        LinearFee localLinearFee = new LinearFee(
            address(token),
            maxFee,
            halfAmount,
            OWNER
        );

        uint256 uncapped = (uint256(amount) * maxFee) /
            (2 * uint256(halfAmount));
        uint256 expectedFee = uncapped > maxFee ? maxFee : uncapped;

        assertEq(
            localLinearFee
            .quoteTransferRemote(destination, recipient, amount)[0].amount,
            expectedFee,
            "Linear fee mismatch"
        );
    }

    function test_RevertIf_ZeroHalfAmount() public {
        vm.expectRevert(bytes("halfAmount must be greater than zero"));
        LinearFee fee = new LinearFee(
            address(token),
            DEFAULT_MAX_FEE,
            0,
            BENEFICIARY
        );
    }

    function test_RevertIf_ZeroMaxFee() public {
        vm.expectRevert(bytes("maxFee must be greater than zero"));
        new LinearFee(address(token), 0, DEFAULT_HALF_AMOUNT, OWNER);
    }

    function test_RevertIf_ZeroOwner() public {
        vm.expectRevert(bytes("owner cannot be zero address"));
        new LinearFee(
            address(token),
            DEFAULT_MAX_FEE,
            DEFAULT_HALF_AMOUNT,
            address(0)
        );
    }
}

// --- ProgressiveFee Tests ---

contract ProgressiveFeeTest is BaseFeeTest {
    uint256 internal constant DEFAULT_MAX_FEE = 1000;
    uint256 internal constant DEFAULT_HALF_AMOUNT = 10000;

    function setUp() public override {
        super.setUp();
        feeContract = new ProgressiveFee(
            address(token),
            DEFAULT_MAX_FEE,
            DEFAULT_HALF_AMOUNT,
            OWNER
        );
    }

    function test_ProgressiveFee_Type() public {
        assertEq(uint(feeContract.feeType()), uint(FeeType.PROGRESSIVE));
    }

    function test_ProgressiveFee_Quote(
        uint96 maxFee,
        uint96 halfAmount,
        uint96 amount
    ) public {
        vm.assume(maxFee > 0);
        vm.assume(halfAmount > 0);
        vm.assume(amount != 0);

        uint256 amountSq = uint256(amount) * amount;
        vm.assume(type(uint256).max / maxFee >= amountSq);

        uint256 halfSq = uint256(halfAmount) * halfAmount;
        vm.assume(type(uint256).max - halfSq >= amountSq);

        ProgressiveFee localProgressiveFee = new ProgressiveFee(
            address(token),
            maxFee,
            halfAmount,
            OWNER
        );

        uint256 expectedFee = (uint256(maxFee) * amountSq) /
            (halfSq + amountSq);

        assertEq(
            localProgressiveFee
            .quoteTransferRemote(destination, recipient, amount)[0].amount,
            expectedFee,
            "Progressive fee mismatch"
        );
    }

    function test_ProgressiveFee_IncreasingPercentageBeforePeak() public {
        // Test that fee percentage increases as amount increases toward halfAmount
        ProgressiveFee localProgressiveFee = new ProgressiveFee(
            address(token),
            1000,
            10000,
            OWNER
        );

        uint256 amount1 = 2000;
        uint256 amount2 = 5000;
        uint256 amount3 = 10000;

        uint256 fee1 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount1)[0].amount;
        uint256 fee2 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount2)[0].amount;
        uint256 fee3 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount3)[0].amount;

        // Calculate percentages (scaled by 1e18 for precision)
        uint256 percentage1 = (fee1 * 1e18) / amount1;
        uint256 percentage2 = (fee2 * 1e18) / amount2;
        uint256 percentage3 = (fee3 * 1e18) / amount3;

        // Verify percentages increase before peak
        assertLt(percentage1, percentage2, "Percentage should increase");
        assertLt(percentage2, percentage3, "Percentage should increase");
    }

    function test_ProgressiveFee_DecreasingPercentageAfterPeak() public {
        // Test that fee percentage decreases as amount increases beyond halfAmount
        ProgressiveFee localProgressiveFee = new ProgressiveFee(
            address(token),
            1000,
            10000,
            OWNER
        );

        uint256 amount1 = 10000;
        uint256 amount2 = 20000;
        uint256 amount3 = 50000;

        uint256 fee1 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount1)[0].amount;
        uint256 fee2 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount2)[0].amount;
        uint256 fee3 = localProgressiveFee
        .quoteTransferRemote(destination, recipient, amount3)[0].amount;

        // Calculate percentages (scaled by 1e18 for precision)
        uint256 percentage1 = (fee1 * 1e18) / amount1;
        uint256 percentage2 = (fee2 * 1e18) / amount2;
        uint256 percentage3 = (fee3 * 1e18) / amount3;

        // Verify percentages decrease after peak
        assertGt(percentage1, percentage2, "Percentage should decrease");
        assertGt(percentage2, percentage3, "Percentage should decrease");
    }

    function test_ProgressiveFee_ZeroAmount() public {
        // Test that fee is zero when amount is zero
        ProgressiveFee localProgressiveFee = new ProgressiveFee(
            address(token),
            1000,
            10000,
            OWNER
        );

        uint256 fee = localProgressiveFee
        .quoteTransferRemote(destination, recipient, 0)[0].amount;

        assertEq(fee, 0, "Fee should be zero for zero amount");
    }
}

// --- RegressiveFee Tests ---

contract RegressiveFeeTest is BaseFeeTest {
    uint256 internal constant DEFAULT_MAX_FEE = 1000;
    uint256 internal constant DEFAULT_HALF_AMOUNT = 10000;

    function setUp() public override {
        super.setUp();
        feeContract = new RegressiveFee(
            address(token),
            DEFAULT_MAX_FEE,
            DEFAULT_HALF_AMOUNT,
            OWNER
        );
    }

    function test_RegressiveFee_Type() public {
        assertEq(uint(feeContract.feeType()), uint(FeeType.REGRESSIVE));
    }

    function test_RegressiveFee_Quote(
        uint96 maxFee,
        uint96 halfAmount,
        uint96 amount
    ) public {
        vm.assume(maxFee > 0);
        vm.assume(halfAmount > 0);
        vm.assume(type(uint256).max - halfAmount >= amount);

        RegressiveFee localRegressiveFee = new RegressiveFee(
            address(token),
            maxFee,
            halfAmount,
            OWNER
        );

        uint256 expectedFee = (uint256(maxFee) * amount) /
            (uint256(halfAmount) + amount);

        assertEq(
            localRegressiveFee
            .quoteTransferRemote(destination, recipient, amount)[0].amount,
            expectedFee,
            "Regressive fee mismatch"
        );
    }

    function test_RegressiveFee_ContinuouslyDecreasingPercentage() public {
        // Test that fee percentage continuously decreases as amount increases
        RegressiveFee localRegressiveFee = new RegressiveFee(
            address(token),
            1000,
            5000,
            OWNER
        );

        uint256 amount1 = 1000;
        uint256 amount2 = 5000;
        uint256 amount3 = 20000;

        uint256 fee1 = localRegressiveFee
        .quoteTransferRemote(destination, recipient, amount1)[0].amount;
        uint256 fee2 = localRegressiveFee
        .quoteTransferRemote(destination, recipient, amount2)[0].amount;
        uint256 fee3 = localRegressiveFee
        .quoteTransferRemote(destination, recipient, amount3)[0].amount;

        // Calculate percentages (scaled by 1e18 for precision)
        uint256 percentage1 = (fee1 * 1e18) / amount1;
        uint256 percentage2 = (fee2 * 1e18) / amount2;
        uint256 percentage3 = (fee3 * 1e18) / amount3;

        // Verify percentages continuously decrease
        assertGt(percentage1, percentage2, "Percentage should decrease");
        assertGt(percentage2, percentage3, "Percentage should decrease");
    }
}

// --- RoutingFee Tests ---

contract RoutingFeeTest is BaseFeeTest {
    RoutingFee public routingFee;
    LinearFee public linearFee1;
    uint32 internal constant DEST1 = 100;
    uint256 internal constant MAX_FEE1 = 500;
    uint256 internal constant HALF_AMOUNT1 = 1000;

    function setUp() public override {
        super.setUp();
        routingFee = new RoutingFee(address(token), OWNER);
        feeContract = routingFee; // for claim test
        linearFee1 = new LinearFee(
            address(token),
            MAX_FEE1,
            HALF_AMOUNT1,
            OWNER
        );
    }

    function test_RoutingFee_Type() public {
        assertEq(uint(routingFee.feeType()), uint(FeeType.ROUTING));
    }

    function test_Quote_NoFeeContract() public {
        // Use a destination that is not configured
        Quote[] memory quotes = routingFee.quoteTransferRemote(
            DEST1 + 1,
            recipient,
            1000
        );
        assertEq(
            quotes.length,
            0,
            "Should return empty if no fee contract set"
        );
    }

    function test_Quote_DelegatesToFeeContract() public {
        vm.prank(OWNER);
        routingFee.setFeeContract(DEST1, address(linearFee1));
        uint256 amount = 2000;
        Quote[] memory quotes = routingFee.quoteTransferRemote(
            DEST1,
            recipient,
            amount
        );
        uint256 expected = (amount * MAX_FEE1) / (2 * HALF_AMOUNT1);
        if (expected > MAX_FEE1) expected = MAX_FEE1;
        assertEq(quotes.length, 1, "Should return one quote");
        assertEq(quotes[0].token, address(token), "Token address mismatch");
        assertEq(quotes[0].amount, expected, "Fee mismatch");
    }

    function test_SetFeeContract_EmitsEvent() public {
        vm.prank(OWNER);
        vm.expectEmit(true, true, false, true, address(routingFee));
        emit RoutingFee.FeeContractSet(DEST1, address(linearFee1));
        routingFee.setFeeContract(DEST1, address(linearFee1));
        assertEq(routingFee.feeContracts(DEST1), address(linearFee1));
    }

    function test_RevertIf_NonOwnerSetsFeeContract() public {
        vm.prank(address(0x999));
        vm.expectRevert("Ownable: caller is not the owner");
        routingFee.setFeeContract(DEST1, address(linearFee1));
    }

    function test_Claim() public override {
        // Test claiming ERC20 tokens from RoutingFee
        uint256 erc20Amount = 100 * 10 ** 18;
        token.mintTo(address(routingFee), erc20Amount);
        uint256 beneficiaryErc20BalanceBefore = token.balanceOf(BENEFICIARY);
        vm.prank(OWNER);
        routingFee.claim(BENEFICIARY);
        uint256 beneficiaryErc20BalanceAfter = token.balanceOf(BENEFICIARY);
        assertEq(
            beneficiaryErc20BalanceAfter - beneficiaryErc20BalanceBefore,
            erc20Amount,
            "ERC20 claim failed"
        );
        assertEq(
            token.balanceOf(address(routingFee)),
            0,
            "ERC20 balance not zero after claim"
        );
    }

    function test_Domains_empty() public {
        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 0);
    }

    function test_Domains_afterSetFeeContract() public {
        uint32 dest1 = 100;
        uint32 dest2 = 200;

        vm.startPrank(OWNER);
        routingFee.setFeeContract(dest1, address(linearFee1));
        routingFee.setFeeContract(dest2, address(linearFee1));
        vm.stopPrank();

        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 2);
    }

    function test_Domains_idempotent() public {
        vm.startPrank(OWNER);
        routingFee.setFeeContract(DEST1, address(linearFee1));
        routingFee.setFeeContract(DEST1, address(linearFee1));
        vm.stopPrank();

        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 1);
    }
}
