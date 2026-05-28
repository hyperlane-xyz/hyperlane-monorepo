// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {PiggyBankSponsorIGP} from "../../contracts/hooks/igp/PiggyBankSponsorIGP.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

contract PiggyBankSponsorIGPTest is Test {
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using Message for bytes;

    PiggyBankSponsorIGP piggyBank;
    StorageGasOracle testOracle;
    StorageGasOracle tokenOracle;
    ERC20Test feeToken;

    address constant SPONSOR = address(0x111111);
    address constant BENEFICIARY = address(0x222222);
    address constant USER = address(0x333333);
    address constant RELAYER = address(0x444444);

    uint32 constant TEST_DEST_DOMAIN = 11111;
    uint96 constant TEST_GAS_OVERHEAD = 123_000;
    uint256 constant TEST_GAS_LIMIT = 300_000;
    uint128 constant TEST_EXCHANGE_RATE = 1e10; // 1.0 exchange rate
    uint128 constant TEST_GAS_PRICE = 150; // 150 wei gas price
    uint256 constant LOW_BALANCE_THRESHOLD = 1 ether;
    uint256 constant DEPOSIT_AMOUNT = 100 ether;

    bytes constant testMessageBody = "hello world";
    bytes testEncodedMessage;

    // Events we expect to emit
    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasAmount,
        uint256 payment
    );
    event Deposited(address indexed sponsor, uint256 amount);
    event Withdrawn(address indexed sponsor, uint256 amount);
    event Collected(address indexed beneficiary, uint256 amount);
    event BeneficiarySet(address indexed beneficiary);
    event LowBalanceWarning(
        address indexed sponsor,
        uint256 remainingBalance,
        uint256 threshold
    );
    event TokenGasOracleSet(
        address indexed feeToken,
        uint32 remoteDomain,
        address gasOracle
    );
    event DestinationGasOverheadSet(
        uint32 indexed remoteDomain,
        uint256 gasOverhead
    );

    function setUp() public {
        // Deploy the piggy bank with SPONSOR as both sponsor and owner
        piggyBank = new PiggyBankSponsorIGP(
            SPONSOR,
            BENEFICIARY,
            LOW_BALANCE_THRESHOLD
        );

        // Set up gas oracle
        testOracle = new StorageGasOracle();
        _setRemoteGasData(TEST_DEST_DOMAIN, TEST_EXCHANGE_RATE, TEST_GAS_PRICE);

        // Configure gas oracle for native token
        PiggyBankSponsorIGP.TokenGasOracleConfig[]
            memory configs = new PiggyBankSponsorIGP.TokenGasOracleConfig[](1);
        configs[0] = PiggyBankSponsorIGP.TokenGasOracleConfig(
            address(0),
            TEST_DEST_DOMAIN,
            testOracle
        );
        vm.prank(SPONSOR);
        piggyBank.setTokenGasOracles(configs);

        // Set gas overhead
        vm.prank(SPONSOR);
        piggyBank.setDestinationGasOverhead(TEST_DEST_DOMAIN, TEST_GAS_OVERHEAD);

        // Set up ERC20 token for token payment tests
        feeToken = new ERC20Test("FeeToken", "FEE", 1_000_000e18, 18);
        tokenOracle = new StorageGasOracle();
        _setTokenRemoteGasData(
            address(feeToken),
            TEST_DEST_DOMAIN,
            TEST_EXCHANGE_RATE,
            TEST_GAS_PRICE
        );

        // Configure gas oracle for ERC20 token
        PiggyBankSponsorIGP.TokenGasOracleConfig[]
            memory tokenConfigs = new PiggyBankSponsorIGP.TokenGasOracleConfig[](
                1
            );
        tokenConfigs[0] = PiggyBankSponsorIGP.TokenGasOracleConfig(
            address(feeToken),
            TEST_DEST_DOMAIN,
            tokenOracle
        );
        vm.prank(SPONSOR);
        piggyBank.setTokenGasOracles(tokenConfigs);

        // Encode a test message
        testEncodedMessage = _encodeTestMessage();
    }

    // ============ Constructor ============

    function testConstructorSetsSponsor() public {
        assertEq(piggyBank.sponsor(), SPONSOR);
    }

    function testConstructorSetsBeneficiary() public {
        assertEq(piggyBank.beneficiary(), BENEFICIARY);
    }

    function testConstructorSetsOwner() public {
        assertEq(piggyBank.owner(), SPONSOR);
    }

    function testConstructorSetsLowBalanceThreshold() public {
        assertEq(piggyBank.lowBalanceThreshold(), LOW_BALANCE_THRESHOLD);
    }

    function testConstructorRevertsOnZeroSponsor() public {
        vm.expectRevert("PiggyBank: zero sponsor");
        new PiggyBankSponsorIGP(address(0), BENEFICIARY, LOW_BALANCE_THRESHOLD);
    }

    function testConstructorRevertsOnZeroBeneficiary() public {
        vm.expectRevert("PiggyBank: zero beneficiary");
        new PiggyBankSponsorIGP(SPONSOR, address(0), LOW_BALANCE_THRESHOLD);
    }

    // ============ Deposit ============

    function testDepositNative() public {
        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit Deposited(SPONSOR, DEPOSIT_AMOUNT);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        assertEq(piggyBank.sponsorBalance(), DEPOSIT_AMOUNT);
    }

    function testDepositNativeByOwner() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        assertEq(piggyBank.sponsorBalance(), DEPOSIT_AMOUNT);
    }

    function testDepositNativeRevertsIfNotSponsor() public {
        vm.prank(USER);
        vm.expectRevert("PiggyBank: not sponsor");
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();
    }

    function testDepositNativeRevertsIfZeroValue() public {
        vm.prank(SPONSOR);
        vm.expectRevert("PiggyBank: zero deposit");
        piggyBank.deposit{value: 0}();
    }

    function testDepositERC20() public {
        uint256 depositAmount = 1000e18;
        feeToken.mint(SPONSOR, depositAmount);
        vm.prank(SPONSOR);
        feeToken.approve(address(piggyBank), depositAmount);

        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit Deposited(SPONSOR, depositAmount);
        piggyBank.depositERC20(address(feeToken), depositAmount);
    }

    function testDepositERC20RevertsIfNotSponsor() public {
        vm.prank(USER);
        vm.expectRevert("PiggyBank: not sponsor");
        piggyBank.depositERC20(address(feeToken), 100);
    }

    // ============ Withdraw ============

    function testWithdrawNative() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        uint256 withdrawAmount = 10 ether;
        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit Withdrawn(SPONSOR, withdrawAmount);
        piggyBank.withdraw(withdrawAmount);

        assertEq(piggyBank.sponsorBalance(), DEPOSIT_AMOUNT - withdrawAmount);
    }

    function testWithdrawNativeRevertsIfNotOwner() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        vm.prank(USER);
        vm.expectRevert("Ownable: caller is not the owner");
        piggyBank.withdraw(1 ether);
    }

    function testWithdrawNativeRevertsIfInsufficientBalance() public {
        vm.prank(SPONSOR);
        vm.expectRevert("PiggyBank: insufficient balance");
        piggyBank.withdraw(1);
    }

    // ============ Claim ============

    function testClaimNative() public {
        // Sponsor deposits
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        // Simulate a gas payment (call payForGas directly)
        uint256 expectedPayment = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        vm.prank(USER);
        piggyBank.payForGas(
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );

        // Beneficiary claims
        uint256 collectedBefore = piggyBank.collectedPayments();
        assertEq(collectedBefore, expectedPayment);

        uint256 beneficiaryBalanceBefore = BENEFICIARY.balance;
        vm.prank(BENEFICIARY);
        vm.expectEmit(true, true, false, true);
        emit Collected(BENEFICIARY, expectedPayment);
        piggyBank.claim();

        assertEq(
            BENEFICIARY.balance,
            beneficiaryBalanceBefore + expectedPayment
        );
        assertEq(piggyBank.collectedPayments(), 0);
    }

    function testClaimNativeRevertsIfNotBeneficiary() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        vm.prank(USER);
        piggyBank.payForGas(
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );

        vm.prank(USER);
        vm.expectRevert("PiggyBank: not beneficiary");
        piggyBank.claim();
    }

    function testClaimNativeRevertsIfNothingToClaim() public {
        vm.prank(BENEFICIARY);
        vm.expectRevert("PiggyBank: nothing to claim");
        piggyBank.claim();
    }

    // ============ Set Beneficiary ============

    function testSetBeneficiary() public {
        address newBeneficiary = address(0x555555);
        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit BeneficiarySet(newBeneficiary);
        piggyBank.setBeneficiary(newBeneficiary);

        assertEq(piggyBank.beneficiary(), newBeneficiary);
    }

    function testSetBeneficiaryRevertsIfNotOwner() public {
        vm.prank(USER);
        vm.expectRevert("Ownable: caller is not the owner");
        piggyBank.setBeneficiary(USER);
    }

    function testSetBeneficiaryRevertsIfZeroAddress() public {
        vm.prank(SPONSOR);
        vm.expectRevert("PiggyBank: zero address");
        piggyBank.setBeneficiary(address(0));
    }

    // ============ PayForGas ============

    function testPayForGasNative() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        uint256 expectedPayment = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        vm.expectEmit(true, true, true, true);
        emit GasPayment(
            bytes32(uint256(42)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            expectedPayment
        );
        vm.prank(USER);
        piggyBank.payForGas(
            bytes32(uint256(42)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );

        assertEq(
            piggyBank.sponsorBalance(),
            DEPOSIT_AMOUNT - expectedPayment
        );
        assertEq(piggyBank.collectedPayments(), expectedPayment);
    }

    function testPayForGasRevertsIfInsufficientSponsorBalance() public {
        // No deposit made, should revert
        vm.prank(USER);
        vm.expectRevert("PiggyBank: insufficient sponsor balance");
        piggyBank.payForGas(
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );
    }

    // ============ Quote Gas Payment ============

    function testQuoteGasPayment() public {
        uint256 quote = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        // Expected: (gasLimit * gasPrice * exchangeRate) / 1e10
        uint256 expected = ((TEST_GAS_LIMIT + TEST_GAS_OVERHEAD) *
            TEST_GAS_PRICE *
            TEST_EXCHANGE_RATE) / 1e10;
        assertEq(quote, expected);
    }

    function testQuoteGasPaymentWithFeeToken() public {
        uint256 quote = piggyBank.quoteGasPayment(
            address(feeToken),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        uint256 expected = ((TEST_GAS_LIMIT + TEST_GAS_OVERHEAD) *
            TEST_GAS_PRICE *
            TEST_EXCHANGE_RATE) / 1e10;
        assertEq(quote, expected);
    }

    function testQuoteGasPaymentRevertsIfNoOracle() public {
        vm.expectRevert("PiggyBank: no gas oracle for domain 99999");
        piggyBank.quoteGasPayment(99999, TEST_GAS_LIMIT);
    }

    // ============ Post Dispatch (Hook) ============

    function testPostDispatchNative() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        bytes memory metadata = StandardHookMetadata.format(
            0,
            TEST_GAS_LIMIT,
            USER
        );

        uint256 expectedPayment = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            piggyBank.destinationGasLimit(TEST_DEST_DOMAIN, TEST_GAS_LIMIT)
        );

        vm.prank(USER);
        piggyBank.postDispatch(metadata, testEncodedMessage);

        assertEq(
            piggyBank.sponsorBalance(),
            DEPOSIT_AMOUNT - expectedPayment
        );
        assertEq(piggyBank.collectedPayments(), expectedPayment);
    }

    function testQuoteDispatch() public {
        bytes memory metadata = StandardHookMetadata.format(
            0,
            TEST_GAS_LIMIT,
            USER
        );

        uint256 quote = piggyBank.quoteDispatch(metadata, testEncodedMessage);

        uint256 expected = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            piggyBank.destinationGasLimit(TEST_DEST_DOMAIN, TEST_GAS_LIMIT)
        );
        assertEq(quote, expected);
    }

    // ============ Low Balance Warning ============

    function testLowBalanceWarningEmitted() public {
        // Deposit exactly the threshold amount
        vm.prank(SPONSOR);
        piggyBank.deposit{value: LOW_BALANCE_THRESHOLD}();

        // Make a payment that will drop balance below threshold
        uint256 payment = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        vm.expectEmit(true, true, true, true);
        emit LowBalanceWarning(
            SPONSOR,
            LOW_BALANCE_THRESHOLD - payment,
            LOW_BALANCE_THRESHOLD
        );
        vm.prank(USER);
        piggyBank.payForGas(
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );
    }

    function testLowBalanceWarningNotEmittedWhenAboveThreshold() public {
        vm.prank(SPONSOR);
        piggyBank.deposit{value: DEPOSIT_AMOUNT}();

        uint256 payment = piggyBank.quoteGasPayment(
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        // Balance after payment: 100 ETH - payment, still well above threshold
        vm.recordLogs();
        vm.prank(USER);
        piggyBank.payForGas(
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT,
            USER
        );

        // Check no LowBalanceWarning was emitted
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertFalse(
                logs[i].topics[0] == keccak256("LowBalanceWarning(address,uint256,uint256)"),
                "LowBalanceWarning should not be emitted"
            );
        }
    }

    function testSetLowBalanceThreshold() public {
        uint256 newThreshold = 5 ether;
        vm.prank(SPONSOR);
        piggyBank.setLowBalanceThreshold(newThreshold);
        assertEq(piggyBank.lowBalanceThreshold(), newThreshold);
    }

    function testSetLowBalanceThresholdRevertsIfNotOwner() public {
        vm.prank(USER);
        vm.expectRevert("Ownable: caller is not the owner");
        piggyBank.setLowBalanceThreshold(1 ether);
    }

    // ============ Destination Gas Limit ============

    function testDestinationGasLimit() public {
        assertEq(
            piggyBank.destinationGasLimit(TEST_DEST_DOMAIN, TEST_GAS_LIMIT),
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );
    }

    function testDestinationGasLimitWhenOverheadNotSet() public {
        assertEq(
            piggyBank.destinationGasLimit(99999, TEST_GAS_LIMIT),
            TEST_GAS_LIMIT
        );
    }

    // ============ Set Destination Gas Overhead ============

    function testSetDestinationGasOverhead() public {
        uint32 domain = 33333;
        uint256 overhead = 99999;

        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit DestinationGasOverheadSet(domain, overhead);
        piggyBank.setDestinationGasOverhead(domain, overhead);

        assertEq(piggyBank.destinationGasOverhead(domain), overhead);
    }

    function testSetDestinationGasOverheadRevertsIfNotOwner() public {
        vm.prank(USER);
        vm.expectRevert("Ownable: caller is not the owner");
        piggyBank.setDestinationGasOverhead(33333, 99999);
    }

    // ============ Set Token Gas Oracles ============

    function testSetTokenGasOracles() public {
        StorageGasOracle newOracle = new StorageGasOracle();
        PiggyBankSponsorIGP.TokenGasOracleConfig[]
            memory configs = new PiggyBankSponsorIGP.TokenGasOracleConfig[](1);
        configs[0] = PiggyBankSponsorIGP.TokenGasOracleConfig(
            address(0),
            TEST_DEST_DOMAIN,
            newOracle
        );

        vm.prank(SPONSOR);
        vm.expectEmit(true, true, false, true);
        emit TokenGasOracleSet(
            address(0),
            TEST_DEST_DOMAIN,
            address(newOracle)
        );
        piggyBank.setTokenGasOracles(configs);

        assertEq(
            address(piggyBank.tokenGasOracles(address(0), TEST_DEST_DOMAIN)),
            address(newOracle)
        );
    }

    function testSetTokenGasOraclesRevertsIfNotOwner() public {
        PiggyBankSponsorIGP.TokenGasOracleConfig[]
            memory configs = new PiggyBankSponsorIGP.TokenGasOracleConfig[](0);
        vm.prank(USER);
        vm.expectRevert("Ownable: caller is not the owner");
        piggyBank.setTokenGasOracles(configs);
    }

    // ============ ERC20 Flow ============

    function testPayForGasWithERC20() public {
        uint256 depositAmount = 10000e18;
        feeToken.mint(SPONSOR, depositAmount);
        vm.prank(SPONSOR);
        feeToken.approve(address(piggyBank), depositAmount);
        vm.prank(SPONSOR);
        piggyBank.depositERC20(address(feeToken), depositAmount);

        uint256 expectedPayment = piggyBank.quoteGasPayment(
            address(feeToken),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT + TEST_GAS_OVERHEAD
        );

        vm.prank(USER);
        piggyBank.payForGas(
            address(feeToken),
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT
        );
    }

    function testClaimERC20() public {
        // Sponsor deposits ERC20
        uint256 depositAmount = 10000e18;
        feeToken.mint(SPONSOR, depositAmount);
        vm.prank(SPONSOR);
        feeToken.approve(address(piggyBank), depositAmount);
        vm.prank(SPONSOR);
        piggyBank.depositERC20(address(feeToken), depositAmount);

        // User triggers a gas payment
        vm.prank(USER);
        piggyBank.payForGas(
            address(feeToken),
            bytes32(uint256(1)),
            TEST_DEST_DOMAIN,
            TEST_GAS_LIMIT
        );

        uint256 beneficiaryBalanceBefore = feeToken.balanceOf(BENEFICIARY);

        vm.prank(BENEFICIARY);
        piggyBank.claimToken(address(feeToken));

        assertGt(feeToken.balanceOf(BENEFICIARY), beneficiaryBalanceBefore);
    }

    // ============ Hook Type ============

    function testHookType() public {
        assertEq(
            piggyBank.hookType(),
            uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER)
        );
    }

    // ============ Supports Metadata ============

    function testSupportsMetadata() public {
        bytes memory metadata = StandardHookMetadata.format(
            0,
            TEST_GAS_LIMIT,
            USER
        );
        assertTrue(piggyBank.supportsMetadata(metadata));
    }

    function testSupportsEmptyMetadata() public {
        assertTrue(piggyBank.supportsMetadata(bytes("")));
    }

    // ============ Helper Functions ============

    function _setRemoteGasData(
        uint32 _domain,
        uint128 _exchangeRate,
        uint128 _gasPrice
    ) internal {
        StorageGasOracle.RemoteGasData[] memory arr = new StorageGasOracle.RemoteGasData[](1);
        arr[0] = StorageGasOracle.RemoteGasData(
            _domain,
            _exchangeRate,
            _gasPrice
        );
        testOracle.setRemoteGasData(arr);
    }

    function _setTokenRemoteGasData(
        address _token,
        uint32 _domain,
        uint128 _exchangeRate,
        uint128 _gasPrice
    ) internal {
        StorageGasOracle.RemoteGasData[] memory arr = new StorageGasOracle.RemoteGasData[](1);
        arr[0] = StorageGasOracle.RemoteGasData(
            _domain,
            _exchangeRate,
            _gasPrice
        );
        tokenOracle.setRemoteGasData(arr);
    }

    function _encodeTestMessage() internal returns (bytes memory) {
        // Build a proper Hyperlane message
        return
            abi.encodePacked(
                uint8(1), // version
                uint32(12345), // origin
                bytes32(uint256(uint160(address(0x999999)))), // sender
                uint32(TEST_DEST_DOMAIN), // destination
                bytes32(uint256(uint160(USER))), // recipient
                testMessageBody // body
            );
    }
}
