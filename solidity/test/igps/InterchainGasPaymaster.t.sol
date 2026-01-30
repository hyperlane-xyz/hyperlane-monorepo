// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {IInterchainGasPaymaster} from "../../contracts/interfaces/IInterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

contract InterchainGasPaymasterTest is Test {
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using MessageUtils for bytes;

    InterchainGasPaymaster igp;
    StorageGasOracle testOracle;
    StorageGasOracle tokenOracle;
    ERC20Test feeToken;

    address constant beneficiary = address(0x444444);

    uint32 constant testOriginDomain = 22222;
    uint32 constant testDestinationDomain = 11111;
    uint256 constant testGasLimit = 300000;
    uint96 constant testGasOverhead = 123000;
    uint256 constant DEFAULT_GAS_USAGE = 50_000;
    uint128 constant TEST_EXCHANGE_RATE = 1e10; // 1.0 exchange rate (remote token has exact same value as local)
    uint128 constant TEST_GAS_PRICE = 150; // 150 wei gas price
    bytes constant testMessage = "hello world";
    bytes32 constant testMessageId =
        0x6ae9a99190641b9ed0c07143340612dde0e9cb7deaa5fe07597858ae9ba5fd7f;
    address constant testRefundAddress = address(0xc0ffee);
    bytes testEncodedMessage;
    address ALICE = address(0x1); // alice the adversary
    uint256 blockNumber;

    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasLimit,
        uint256 payment
    );
    event BeneficiarySet(address beneficiary);
    event DestinationGasConfigSet(
        uint32 remoteDomain,
        address gasOracle,
        uint96 gasOverhead
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
        blockNumber = block.number;
        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), beneficiary);
        testOracle = new StorageGasOracle();
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            testGasOverhead
        );

        // Set up token payment infrastructure
        feeToken = new ERC20Test("FeeToken", "FEE", 1_000_000e18, 18);
        tokenOracle = new StorageGasOracle();
        setTokenGasOracle(
            address(feeToken),
            testDestinationDomain,
            tokenOracle
        );

        testEncodedMessage = _encodeTestMessage();
    }

    // ============ constructor ============

    function testConstructorSetsBeneficiary() public {
        assertEq(igp.beneficiary(), beneficiary);
    }

    function testConstructorSetsDeployedBlock() public {
        assertEq(igp.deployedBlock(), blockNumber);
    }

    // ============ initialize ============

    function testInitializeRevertsIfCalledTwice() public {
        vm.expectRevert("Initializable: contract is already initialized");
        igp.initialize(address(this), beneficiary);
    }

    function testdestinationGasLimit(uint96 _gasOverhead) public {
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            _gasOverhead
        );
        assertEq(
            igp.destinationGasLimit(testDestinationDomain, testGasLimit),
            _gasOverhead + testGasLimit
        );
    }

    function testdestinationGasLimit_whenOverheadNotSet(
        uint32 _otherDomains
    ) public {
        vm.assume(_otherDomains != testDestinationDomain);
        assertEq(
            igp.destinationGasLimit(_otherDomains, testGasLimit),
            testGasLimit
        );
    }

    // ============ setBeneficiary ============

    function testSetBeneficiary() public {
        address _newBeneficiary = address(0xbeeeeee);

        vm.expectEmit(true, false, false, true);
        emit BeneficiarySet(_newBeneficiary);
        igp.setBeneficiary(_newBeneficiary);

        assertEq(igp.beneficiary(), _newBeneficiary);
    }

    function testSetBeneficiaryRevertsIfNotOwner() public {
        address _newBeneficiary = address(0xbeeeeee);

        // Repurpose the refund address as a non-owner to prank as
        vm.prank(testRefundAddress);

        vm.expectRevert("Ownable: caller is not the owner");
        igp.setBeneficiary(_newBeneficiary);
    }

    // ============ getExchangeRateAndGasPrice ============

    function testGetExchangeRateAndGasPrice() public {
        uint128 _tokenExchangeRate = 1 * TEST_EXCHANGE_RATE;
        // 1 wei gas price
        uint128 _gasPrice = 1;
        setRemoteGasData(testDestinationDomain, _tokenExchangeRate, _gasPrice);

        (uint128 _actualTokenExchangeRate, uint128 _actualGasPrice) = igp
            .getExchangeRateAndGasPrice(testDestinationDomain);
        assertEq(_actualTokenExchangeRate, _tokenExchangeRate);
        assertEq(_actualGasPrice, _gasPrice);
    }

    function testGetExchangeRateAndGasPriceRevertsIfNoGasOracleSet() public {
        uint32 _unknownDomain = 22222;

        vm.expectRevert("Configured IGP doesn't support domain 22222");
        igp.getExchangeRateAndGasPrice(_unknownDomain);
    }

    // ============ setDestinationGasConfigs ============

    function testSetDestinationGasConfigs(
        uint32 _domain1,
        uint32 _domain2,
        uint96 _gasOverhead1,
        uint96 _gasOverhead2
    ) public {
        vm.assume(_domain1 != _domain2);
        StorageGasOracle oracle1 = new StorageGasOracle();
        StorageGasOracle oracle2 = new StorageGasOracle();
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](2);
        params[0] = InterchainGasPaymaster.GasParam(
            _domain1,
            InterchainGasPaymaster.DomainGasConfig(oracle1, _gasOverhead1)
        );
        params[1] = InterchainGasPaymaster.GasParam(
            _domain2,
            InterchainGasPaymaster.DomainGasConfig(oracle2, _gasOverhead2)
        );

        // Data = remoteDomain, gasOracle, gasOverhead
        vm.expectEmit(false, false, false, true, address(igp));
        emit DestinationGasConfigSet(
            params[0].remoteDomain,
            address(params[0].config.gasOracle),
            params[0].config.gasOverhead
        );
        vm.expectEmit(false, false, false, true, address(igp));
        emit DestinationGasConfigSet(
            params[1].remoteDomain,
            address(params[1].config.gasOracle),
            params[1].config.gasOverhead
        );

        igp.setDestinationGasConfigs(params);

        (IGasOracle actualOracle1, uint96 actualGasOverhead1) = igp
            .destinationGasConfigs(_domain1);
        assertEq(address(actualOracle1), address(oracle1));
        assertEq(actualGasOverhead1, _gasOverhead1);

        (IGasOracle actualOracle2, uint96 actualGasOverhead2) = igp
            .destinationGasConfigs(_domain2);
        assertEq(address(actualOracle2), address(oracle2));
        assertEq(actualGasOverhead2, _gasOverhead2);
    }

    function testSetDestinationGasConfigs_reverts_notOwner(
        uint32 _domain1,
        uint32 _domain2,
        uint96 _gasOverhead1,
        uint96 _gasOverhead2
    ) public {
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](2);
        params[0] = InterchainGasPaymaster.GasParam(
            _domain1,
            InterchainGasPaymaster.DomainGasConfig(testOracle, _gasOverhead1)
        );
        params[1] = InterchainGasPaymaster.GasParam(
            _domain2,
            InterchainGasPaymaster.DomainGasConfig(testOracle, _gasOverhead2)
        );

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        igp.setDestinationGasConfigs(params);
    }

    // ============ quoteGasPayment ============

    function testQuoteGasPaymentSimilarExchangeRate() public {
        // Testing when exchange rates are relatively close
        setRemoteGasData(
            testDestinationDomain,
            2 * 1e9, // 0.2 exchange rate (remote token less valuable)
            TEST_GAS_PRICE * 1e9 // 150 gwei gas price
        );

        // 300,000 destination gas
        // 150 gwei = 150000000000 wei
        // 300,000 * 150000000000 = 45000000000000000 (0.045 remote eth)
        // Using the 0.2 token exchange rate, meaning the local native token
        // is 5x more valuable than the remote token:
        // 45000000000000000 * 0.2 = 9000000000000000 (0.009 local eth)
        assertEq(
            igp.quoteGasPayment(testDestinationDomain, testGasLimit),
            9000000000000000
        );
    }

    function testQuoteGasPaymentRemoteVeryExpensive() public {
        // Testing when the remote token is much more valuable & there's a super high gas price
        setRemoteGasData(
            testDestinationDomain,
            5000 * TEST_EXCHANGE_RATE,
            1500 * 1e9 // 1500 gwei gas price
        );

        // 300,000 destination gas
        // 1500 gwei = 1500000000000 wei
        // 300,000 * 1500000000000 = 450000000000000000 (0.45 remote eth)
        // Using the 5000 token exchange rate, meaning the remote native token
        // is 5000x more valuable than the local token:
        // 450000000000000000 * 5000 = 2250000000000000000000 (2250 local eth)
        assertEq(
            igp.quoteGasPayment(testDestinationDomain, testGasLimit),
            2250000000000000000000
        );
    }

    function testQuoteGasPaymentRemoteVeryCheap() public {
        // Testing when the remote token is much less valuable & there's a low gas price
        setRemoteGasData(
            testDestinationDomain,
            4 * 1e8, // 0.04 exchange rate (remote token much less valuable)
            1 * 1e8 // 0.1 gwei gas price
        );

        // 300,000 destination gas
        // 0.1 gwei = 100000000 wei
        // 300,000 * 100000000 = 30000000000000 (0.00003 remote eth)
        // Using the 0.04 token exchange rate, meaning the remote native token
        // is 0.04x the price of the local token:
        // 30000000000000 * 0.04 = 1200000000000 (0.0000012 local eth)
        assertEq(
            igp.quoteGasPayment(testDestinationDomain, testGasLimit),
            1200000000000
        );
    }

    function testQuoteGasPaymentRevertsIfNoGasOracleSet() public {
        uint32 _unknownDomain = 22222;

        vm.expectRevert("IGP: no gas oracle for domain 22222");
        igp.quoteGasPayment(_unknownDomain, testGasLimit);
    }

    // ============ payForGas ============

    function testPayForGas() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = testRefundAddress.balance;

        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasLimit
        );
        // Intentional overpayment
        uint256 _overpayment = 54321;

        vm.expectEmit(true, true, false, true);
        emit GasPayment(
            testMessageId,
            testDestinationDomain,
            testGasLimit,
            _quote
        );
        igp.payForGas{value: _quote + _overpayment}(
            testMessageId,
            testDestinationDomain,
            testGasLimit,
            testRefundAddress
        );

        uint256 _igpBalanceAfter = address(igp).balance;
        uint256 _refundAddressBalanceAfter = testRefundAddress.balance;

        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
        assertEq(
            _refundAddressBalanceAfter - _refundAddressBalanceBefore,
            _overpayment
        );
    }

    function testPayForGas_reverts_ifPaymentInsufficient() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );

        vm.expectRevert("IGP: insufficient interchain gas payment");
        // Pay no msg.value
        igp.payForGas{value: 0}(
            testMessageId,
            testDestinationDomain,
            testGasLimit,
            testRefundAddress
        );
    }

    function testPayForGas_withOverhead(
        uint128 _gasLimit,
        uint96 _gasOverhead
    ) public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            _gasOverhead
        );

        uint256 gasWithOverhead = uint256(_gasOverhead) + _gasLimit;
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            gasWithOverhead
        );
        vm.deal(address(this), _quote);

        uint256 _igpBalanceBefore = address(igp).balance;

        vm.expectEmit(true, true, false, true);
        emit GasPayment(
            testMessageId,
            testDestinationDomain,
            gasWithOverhead,
            _quote
        );
        igp.payForGas{value: _quote}(
            testMessageId,
            testDestinationDomain,
            gasWithOverhead,
            msg.sender
        );

        uint256 _igpBalanceAfter = address(igp).balance;

        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
    }

    // ============ quoteDispatch ============

    function testQuoteDispatch_defaultGasLimit() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            TEST_GAS_PRICE
        );

        // 150 (gas_price) * 50_000 + 123_000 (default_gas_limit) = 25_950_000
        assertEq(igp.quoteDispatch("", testEncodedMessage), 25_950_000);
    }

    function testQuoteDispatch_customWithMetadata() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            TEST_GAS_PRICE
        );

        bytes memory metadata = StandardHookMetadata.overrideGasLimit(
            uint256(testGasLimit)
        );
        // 150 * (300_000 + 123_000) = 45_000_000
        assertEq(igp.quoteDispatch(metadata, testEncodedMessage), 63_450_000);
    }

    // ============ postDispatch ============

    function testPostDispatch_defaultGasLimit() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = address(this).balance;
        uint256 _quote = igp.quoteDispatch("", testEncodedMessage);
        uint256 _overpayment = 21000;

        igp.postDispatch{value: _quote + _overpayment}("", testEncodedMessage);

        uint256 _igpBalanceAfter = address(igp).balance;
        uint256 _refundAddressBalanceAfter = address(this).balance;
        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
        assertEq(
            _refundAddressBalanceBefore - _refundAddressBalanceAfter,
            _quote
        );
    }

    function testPostDispatch_customWithMetadata() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = testRefundAddress.balance;

        uint256 _overpayment = 25000;
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            uint256(testGasLimit), // gas limit
            testRefundAddress, // refund address
            bytes("")
        );
        bytes memory message = _encodeTestMessage();

        uint256 _quote = igp.quoteDispatch(metadata, testEncodedMessage);
        igp.postDispatch{value: _quote + _overpayment}(metadata, message);

        uint256 _igpBalanceAfter = address(igp).balance;
        uint256 _refundAddressBalanceAfter = testRefundAddress.balance;

        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
        assertEq(
            _refundAddressBalanceAfter - _refundAddressBalanceBefore,
            _overpayment
        );
    }

    function testPostDispatch__withOverheadSet(uint96 _gasOverhead) public {
        vm.deal(address(this), _gasOverhead + DEFAULT_GAS_USAGE);

        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            _gasOverhead
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            igp.destinationGasLimit(testDestinationDomain, DEFAULT_GAS_USAGE)
        );

        igp.postDispatch{value: _quote}("", testEncodedMessage);
        uint256 _igpBalanceAfter = address(igp).balance;
        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
    }

    function testPostDispatch_customWithMetadataAndOverhead(
        uint96 _gasOverhead
    ) public {
        vm.deal(address(this), _gasOverhead + testGasLimit);

        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            _gasOverhead
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            igp.destinationGasLimit(testDestinationDomain, testGasLimit)
        );

        bytes memory metadata = StandardHookMetadata.overrideGasLimit(
            uint256(testGasLimit)
        );
        bytes memory message = _encodeTestMessage();
        igp.postDispatch{value: _quote}(metadata, message);
        uint256 _igpBalanceAfter = address(igp).balance;
        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
    }

    function testHookType() public {
        assertEq(
            igp.hookType(),
            uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER)
        );
    }

    // ============ claim ============

    function testClaim() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );
        // Pay some funds into the IGP
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasLimit
        );
        console.log("quote", _quote);
        igp.payForGas{value: _quote}(
            testMessageId,
            testDestinationDomain,
            testGasLimit,
            testRefundAddress
        );

        uint256 _beneficiaryBalanceBefore = beneficiary.balance;
        igp.claim();
        uint256 _beneficiaryBalanceAfter = beneficiary.balance;

        assertEq(_beneficiaryBalanceAfter - _beneficiaryBalanceBefore, _quote);
        assertEq(address(igp).balance, 0);
    }

    // ============ Token Payment Tests ============

    function testSetTokenGasOracles() public {
        address newFeeToken = address(0xBEEF);
        uint32 newDomain = 99999;
        StorageGasOracle newOracle = new StorageGasOracle();

        // First configure domain with native token oracle
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory nativeParams = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        nativeParams[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            address(0), // NATIVE_TOKEN
            newDomain,
            newOracle
        );
        igp.setTokenGasOracles(nativeParams);

        // Now set non-native token oracle
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory params = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        params[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            newFeeToken,
            newDomain,
            newOracle
        );

        vm.expectEmit(true, false, false, true, address(igp));
        emit TokenGasOracleSet(newFeeToken, newDomain, address(newOracle));

        igp.setTokenGasOracles(params);

        IGasOracle actualOracle = igp.tokenGasOracles(newFeeToken, newDomain);
        assertEq(address(actualOracle), address(newOracle));
    }

    function testSetTokenGasOracles_reverts_notOwner() public {
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory params = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        params[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            address(feeToken),
            testDestinationDomain,
            tokenOracle
        );

        vm.expectRevert("Ownable: caller is not the owner");
        vm.prank(ALICE);
        igp.setTokenGasOracles(params);
    }

    function testQuoteGasPaymentWithToken() public {
        setTokenRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE, // 1:1 exchange rate
            TEST_GAS_PRICE // 150 wei gas price
        );

        // quoteGasPayment does NOT add overhead - caller is responsible
        // gasLimit (300000) * 150 = 45000000
        uint256 expectedQuote = 45000000;
        uint256 actualQuote = igp.quoteGasPayment(
            address(feeToken),
            testDestinationDomain,
            testGasLimit
        );
        assertEq(actualQuote, expectedQuote);
    }

    function testQuoteGasPaymentWithToken_differentExchangeRate() public {
        // Remote token is 2x more valuable
        setTokenRemoteGasData(
            testDestinationDomain,
            2 * TEST_EXCHANGE_RATE,
            TEST_GAS_PRICE
        );

        // quoteGasPayment does NOT add overhead - caller is responsible
        // gasLimit (300000) * 150 * 2 = 90000000
        uint256 expectedQuote = 90000000;
        uint256 actualQuote = igp.quoteGasPayment(
            address(feeToken),
            testDestinationDomain,
            testGasLimit
        );
        assertEq(actualQuote, expectedQuote);
    }

    function testQuoteGasPaymentWithToken_reverts_unsupportedToken() public {
        address unsupportedToken = address(0xDEAD);

        vm.expectRevert("IGP: no gas oracle for domain 11111");
        igp.quoteGasPayment(
            unsupportedToken,
            testDestinationDomain,
            testGasLimit
        );
    }

    function testQuoteGasPaymentWithToken_reverts_unsupportedDomain() public {
        uint32 unsupportedDomain = 99999;

        vm.expectRevert("IGP: no gas oracle for domain 99999");
        igp.quoteGasPayment(address(feeToken), unsupportedDomain, testGasLimit);
    }

    function testPostDispatch_withTokenFee() public {
        setTokenRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            1 // 1 wei gas price
        );

        // Get total gas including overhead (token payments use native overhead)
        uint256 totalGas = igp.destinationGasLimit(
            testDestinationDomain,
            testGasLimit
        );
        uint256 quote = igp.quoteGasPayment(
            address(feeToken),
            testDestinationDomain,
            totalGas
        );

        // Approve IGP to spend fee tokens
        feeToken.approve(address(igp), quote);

        uint256 igpTokenBalanceBefore = feeToken.balanceOf(address(igp));
        uint256 senderTokenBalanceBefore = feeToken.balanceOf(address(this));

        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            testGasLimit,
            testRefundAddress,
            address(feeToken)
        );

        bytes32 messageId = keccak256(testEncodedMessage);
        vm.expectEmit(true, true, false, true);
        emit GasPayment(messageId, testDestinationDomain, totalGas, quote);

        igp.postDispatch{value: 0}(metadata, testEncodedMessage);

        uint256 igpTokenBalanceAfter = feeToken.balanceOf(address(igp));
        uint256 senderTokenBalanceAfter = feeToken.balanceOf(address(this));

        assertEq(igpTokenBalanceAfter - igpTokenBalanceBefore, quote);
        assertEq(senderTokenBalanceBefore - senderTokenBalanceAfter, quote);
    }

    function testPostDispatch_withTokenFee_reverts_insufficientAllowance()
        public
    {
        setTokenRemoteGasData(testDestinationDomain, 1 * TEST_EXCHANGE_RATE, 1);

        // Don't approve IGP
        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            testGasLimit,
            testRefundAddress,
            address(feeToken)
        );

        vm.expectRevert("ERC20: insufficient allowance");
        igp.postDispatch{value: 0}(metadata, testEncodedMessage);
    }

    function testQuoteDispatch_withTokenFee() public {
        setTokenRemoteGasData(
            testDestinationDomain,
            1 * TEST_EXCHANGE_RATE,
            TEST_GAS_PRICE
        );

        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            testGasLimit,
            testRefundAddress,
            address(feeToken)
        );

        // gasLimit (300000) + gasOverhead (123000) = 423000
        // 423000 * 150 = 63450000
        uint256 expectedQuote = 63450000;
        assertEq(
            igp.quoteDispatch(metadata, testEncodedMessage),
            expectedQuote
        );
    }

    function testClaimToken() public {
        setTokenRemoteGasData(testDestinationDomain, 1 * TEST_EXCHANGE_RATE, 1);

        // Get total gas including overhead (token payments use native overhead)
        uint256 totalGas = igp.destinationGasLimit(
            testDestinationDomain,
            testGasLimit
        );
        uint256 quote = igp.quoteGasPayment(
            address(feeToken),
            testDestinationDomain,
            totalGas
        );

        // Approve and pay
        feeToken.approve(address(igp), quote);
        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            testGasLimit,
            testRefundAddress,
            address(feeToken)
        );
        igp.postDispatch{value: 0}(metadata, testEncodedMessage);

        uint256 beneficiaryBalanceBefore = feeToken.balanceOf(beneficiary);
        uint256 igpBalanceBefore = feeToken.balanceOf(address(igp));

        igp.claimToken(address(feeToken));

        uint256 beneficiaryBalanceAfter = feeToken.balanceOf(beneficiary);
        uint256 igpBalanceAfter = feeToken.balanceOf(address(igp));

        assertEq(beneficiaryBalanceAfter - beneficiaryBalanceBefore, quote);
        assertEq(igpBalanceBefore - igpBalanceAfter, quote);
        assertEq(igpBalanceAfter, 0);
    }

    function testSupportsMetadata_variant1() public view {
        bytes memory metadata = StandardHookMetadata.overrideGasLimit(
            testGasLimit
        );
        assertTrue(igp.supportsMetadata(metadata));
    }

    function testSupportsMetadata_variant2() public view {
        bytes memory metadata = StandardHookMetadata.formatWithFeeToken(
            0,
            testGasLimit,
            testRefundAddress,
            address(feeToken)
        );
        assertTrue(igp.supportsMetadata(metadata));
    }

    function testSupportsMetadata_emptyMetadata() public view {
        bytes memory metadata = "";
        assertTrue(igp.supportsMetadata(metadata));
    }

    // ============ Helper functions ============

    function setTestDestinationGasConfig(
        uint32 _remoteDomain,
        IGasOracle _gasOracle,
        uint96 _gasOverhead
    ) internal {
        // Set native gas oracle via tokenGasOracles with address(0)
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory oracleParams = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        oracleParams[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            address(0), // NATIVE_TOKEN
            _remoteDomain,
            _gasOracle
        );
        igp.setTokenGasOracles(oracleParams);

        // Set gas overhead via destinationGasOverhead
        igp.setDestinationGasOverhead(_remoteDomain, _gasOverhead);
    }

    function setRemoteGasData(
        uint32 _remoteDomain,
        uint128 _tokenExchangeRate,
        uint128 _gasPrice
    ) internal {
        testOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: _remoteDomain,
                tokenExchangeRate: _tokenExchangeRate,
                gasPrice: _gasPrice
            })
        );
    }

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                uint8(0),
                uint32(0),
                testOriginDomain,
                TypeCasts.addressToBytes32(address(this)),
                testDestinationDomain,
                TypeCasts.addressToBytes32(address(0x1)),
                testMessage
            );
    }

    function setTokenGasOracle(
        address _feeToken,
        uint32 _remoteDomain,
        IGasOracle _gasOracle
    ) internal {
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory params = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );

        params[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            _feeToken,
            _remoteDomain,
            _gasOracle
        );
        igp.setTokenGasOracles(params);
    }

    function setTokenRemoteGasData(
        uint32 _remoteDomain,
        uint128 _tokenExchangeRate,
        uint128 _gasPrice
    ) internal {
        tokenOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: _remoteDomain,
                tokenExchangeRate: _tokenExchangeRate,
                gasPrice: _gasPrice
            })
        );
    }

    receive() external payable {}

    // ============ domains ============

    function testDomains_empty() public {
        InterchainGasPaymaster newIgp = new InterchainGasPaymaster();
        newIgp.initialize(address(this), beneficiary);
        uint32[] memory domains = newIgp.domains();
        assertEq(domains.length, 0);
    }

    function testDomains_afterSetConfig() public {
        uint32 domain1 = 1;
        uint32 domain2 = 2;
        uint32 domain3 = 3;

        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](3);
        params[0] = InterchainGasPaymaster.GasParam(
            domain1,
            InterchainGasPaymaster.DomainGasConfig(testOracle, 100)
        );
        params[1] = InterchainGasPaymaster.GasParam(
            domain2,
            InterchainGasPaymaster.DomainGasConfig(testOracle, 200)
        );
        params[2] = InterchainGasPaymaster.GasParam(
            domain3,
            InterchainGasPaymaster.DomainGasConfig(testOracle, 300)
        );

        igp.setDestinationGasConfigs(params);

        uint32[] memory domains = igp.domains();
        assertEq(domains.length, 4); // 3 new + 1 from setUp

        bool found1;
        bool found2;
        bool found3;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == domain1) found1 = true;
            if (domains[i] == domain2) found2 = true;
            if (domains[i] == domain3) found3 = true;
        }
        assertTrue(found1 && found2 && found3);
    }

    function testDomains_idempotent() public {
        uint32[] memory domainsBefore = igp.domains();

        // Set same domain again (testDestinationDomain was set in setUp)
        setTestDestinationGasConfig(
            testDestinationDomain,
            testOracle,
            testGasOverhead
        );

        uint32[] memory domainsAfter = igp.domains();
        assertEq(domainsAfter.length, domainsBefore.length);
    }

    function testDomains_removedWhenGasOracleZero() public {
        // Verify domain exists after setUp
        uint32[] memory domainsBefore = igp.domains();
        assertEq(domainsBefore.length, 1);
        assertEq(domainsBefore[0], testDestinationDomain);

        // Set gas oracle to zero address to remove domain
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](1);
        params[0] = InterchainGasPaymaster.GasParam(
            testDestinationDomain,
            InterchainGasPaymaster.DomainGasConfig(IGasOracle(address(0)), 0)
        );
        igp.setDestinationGasConfigs(params);

        // Verify domain is removed
        uint32[] memory domainsAfter = igp.domains();
        assertEq(domainsAfter.length, 0);
    }

    function testDomains_removeNonExistentNoOp() public {
        InterchainGasPaymaster newIgp = new InterchainGasPaymaster();
        newIgp.initialize(address(this), beneficiary);

        // Remove non-existent domain should not revert
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](1);
        params[0] = InterchainGasPaymaster.GasParam(
            999,
            InterchainGasPaymaster.DomainGasConfig(IGasOracle(address(0)), 0)
        );
        newIgp.setDestinationGasConfigs(params);

        uint32[] memory domains = newIgp.domains();
        assertEq(domains.length, 0);
    }

    function testDomains_readdAfterRemoval() public {
        // Remove domain
        InterchainGasPaymaster.GasParam[]
            memory removeParams = new InterchainGasPaymaster.GasParam[](1);
        removeParams[0] = InterchainGasPaymaster.GasParam(
            testDestinationDomain,
            InterchainGasPaymaster.DomainGasConfig(IGasOracle(address(0)), 0)
        );
        igp.setDestinationGasConfigs(removeParams);
        assertEq(igp.domains().length, 0);

        // Re-add domain
        InterchainGasPaymaster.GasParam[]
            memory addParams = new InterchainGasPaymaster.GasParam[](1);
        addParams[0] = InterchainGasPaymaster.GasParam(
            testDestinationDomain,
            InterchainGasPaymaster.DomainGasConfig(testOracle, testGasOverhead)
        );
        igp.setDestinationGasConfigs(addParams);

        uint32[] memory domains = igp.domains();
        assertEq(domains.length, 1);
        assertEq(domains[0], testDestinationDomain);
    }

    function testSetTokenGasOracle_revertsForNonNativeWhenDomainNotConfigured()
        public
    {
        // Create a fresh IGP with no domains configured
        InterchainGasPaymaster newIgp = new InterchainGasPaymaster();
        newIgp.initialize(address(this), beneficiary);

        // Try to set non-native token oracle without native token configured first
        address nonNativeToken = address(1);
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory configs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        configs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            nonNativeToken,
            testDestinationDomain,
            testOracle
        );

        vm.expectRevert("InterchainGasPaymaster: domain not configured");
        newIgp.setTokenGasOracles(configs);
    }

    function testSetTokenGasOracle_allowsNonNativeWhenDomainConfigured()
        public
    {
        // Domain already configured in setUp via setDestinationGasConfigs (native token)
        assertEq(igp.domains().length, 1);

        // Setting non-native token oracle should succeed
        address nonNativeToken = address(1);
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory configs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        configs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            nonNativeToken,
            testDestinationDomain,
            testOracle
        );

        igp.setTokenGasOracles(configs);

        // Verify oracle was set
        assertEq(
            address(igp.tokenGasOracles(nonNativeToken, testDestinationDomain)),
            address(testOracle)
        );
        // Domain count unchanged
        assertEq(igp.domains().length, 1);
    }

    function testDomains_notRemovedWhenNonNativeTokenOracleCleared() public {
        // Domain exists after setUp with native token oracle
        uint32[] memory domainsBefore = igp.domains();
        assertEq(domainsBefore.length, 1);
        assertEq(domainsBefore[0], testDestinationDomain);

        // Add a non-native token oracle for the same domain
        address nonNativeToken = address(1);
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory addConfigs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        addConfigs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            nonNativeToken,
            testDestinationDomain,
            testOracle
        );
        igp.setTokenGasOracles(addConfigs);

        // Clear the non-native token oracle
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory clearConfigs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        clearConfigs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            nonNativeToken,
            testDestinationDomain,
            IGasOracle(address(0))
        );
        igp.setTokenGasOracles(clearConfigs);

        // Domain should STILL be tracked because native token oracle is still set
        uint32[] memory domainsAfter = igp.domains();
        assertEq(domainsAfter.length, 1);
        assertEq(domainsAfter[0], testDestinationDomain);
    }
}
