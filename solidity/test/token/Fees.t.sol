// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

import {BaseFee, FeeType} from "../../contracts/token/fees/BaseFee.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {ProgressiveFee} from "../../contracts/token/fees/ProgressiveFee.sol";
import {RegressiveFee} from "../../contracts/token/fees/RegressiveFee.sol";

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

    function test_Claim() public {
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
        vm.assume(halfAmount > 0);

        LinearFee localLinearFee = new LinearFee(
            address(token),
            maxFee,
            halfAmount,
            OWNER
        );

        uint256 uncapped = (uint256(amount) * maxFee) / halfAmount;
        uint256 expectedFee = uncapped > maxFee ? maxFee : uncapped;

        assertEq(
            localLinearFee
            .quoteTransferRemote(destination, recipient, amount)[0].amount,
            expectedFee,
            "Linear fee mismatch"
        );
    }

    function test_RevertIf_ZeroHalfAmount(uint96 maxFee, uint96 amount) public {
        vm.assume(amount > 0);
        LinearFee fee = new LinearFee(address(token), maxFee, 0, BENEFICIARY);
        vm.expectRevert();
        fee.quoteTransferRemote(destination, recipient, amount);
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
        vm.assume(halfAmount != 0 || amount != 0);

        uint256 amountSq = uint256(amount) * amount;
        vm.assume(maxFee == 0 || type(uint256).max / maxFee >= amountSq);

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
        vm.assume(halfAmount != 0 || amount != 0);
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
}
