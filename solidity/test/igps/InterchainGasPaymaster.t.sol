// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {IGPMetadata} from "../../contracts/libs/hooks/IGPMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {InterchainGasPaymaster} from "../../contracts/igps/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/igps/gas-oracles/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";

contract InterchainGasPaymasterTest is Test {
    using IGPMetadata for bytes;
    using TypeCasts for address;
    using MessageUtils for bytes;

    InterchainGasPaymaster igp;
    StorageGasOracle oracle;

    address constant beneficiary = address(0x444444);

    uint32 constant testOriginDomain = 22222;
    uint32 constant testDestinationDomain = 11111;
    uint256 constant testGasAmount = 300000;
    bytes constant testMessage = "hello world";
    bytes32 constant testMessageId =
        0x6ae9a99190641b9ed0c07143340612dde0e9cb7deaa5fe07597858ae9ba5fd7f;
    address constant testRefundAddress = address(0xc0ffee);
    bytes testEncodedMessage;

    uint256 blockNumber;

    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasAmount,
        uint256 payment
    );

    event GasOracleSet(uint32 indexed remoteDomain, address gasOracle);

    event BeneficiarySet(address beneficiary);

    function setUp() public {
        blockNumber = block.number;
        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), beneficiary);
        oracle = new StorageGasOracle();
        setGasOracle(testDestinationDomain, address(oracle));

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

    // ============ quoteDispatch ============

    function testQuoteDispatch_defaultGasLimit() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            150 // 1 wei gas price
        );

        // 150 * 69_420 = 10_413_000
        assertEq(igp.quoteDispatch("", testEncodedMessage), 10_413_000);
    }

    function testQuoteDispatch_customWithMetadata() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            150 // 1 wei gas price
        );

        bytes memory metadata = IGPMetadata.formatMetadata(
            uint256(testGasAmount), // gas limit
            testRefundAddress // refund address
        );
        // 150 * 300_000 = 45_000_000
        assertEq(igp.quoteDispatch(metadata, testEncodedMessage), 45_000_000);
    }

    // ============ postDispatch ============

    function testPostDispatch_defaultGasLimit() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = address(this).balance;
        uint256 _quote = igp.quoteGasPayment(testDestinationDomain, 69_420);

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
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = testRefundAddress.balance;
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasAmount
        );

        uint256 _overpayment = 25000;
        bytes memory metadata = IGPMetadata.formatMetadata(
            uint256(testGasAmount), // gas limit
            testRefundAddress // refund address
        );
        bytes memory message = _encodeTestMessage();

        igp.postDispatch{value: _quote + _overpayment}(metadata, message);

        uint256 _igpBalanceAfter = address(igp).balance;
        uint256 _refundAddressBalanceAfter = testRefundAddress.balance;

        assertEq(_igpBalanceAfter - _igpBalanceBefore, _quote);
        assertEq(
            _refundAddressBalanceAfter - _refundAddressBalanceBefore,
            _overpayment
        );
    }

    // ============ payForGas ============

    function testPayForGas() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            1 // 1 wei gas price
        );

        uint256 _igpBalanceBefore = address(igp).balance;
        uint256 _refundAddressBalanceBefore = testRefundAddress.balance;

        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasAmount
        );
        // Intentional overpayment
        uint256 _overpayment = 54321;

        vm.expectEmit(true, true, false, true);
        emit GasPayment(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
            _quote
        );
        igp.payForGas{value: _quote + _overpayment}(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
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

    function testPayForGasRevertsIfPaymentInsufficient() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            1 // 1 wei gas price
        );

        vm.expectRevert("insufficient interchain gas payment");
        // Pay no msg.value
        igp.payForGas{value: 0}(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
            testRefundAddress
        );
    }

    // ============ quoteGasPayment ============

    function testQuoteGasPaymentSimilarExchangeRate() public {
        // Testing when exchange rates are relatively close
        setRemoteGasData(
            testDestinationDomain,
            2 * 1e9, // 0.2 exchange rate (remote token less valuable)
            150 * 1e9 // 150 gwei gas price
        );

        // 300,000 destination gas
        // 150 gwei = 150000000000 wei
        // 300,000 * 150000000000 = 45000000000000000 (0.045 remote eth)
        // Using the 0.2 token exchange rate, meaning the local native token
        // is 5x more valuable than the remote token:
        // 45000000000000000 * 0.2 = 9000000000000000 (0.009 local eth)
        assertEq(
            igp.quoteGasPayment(testDestinationDomain, testGasAmount),
            9000000000000000
        );
    }

    function testQuoteGasPaymentRemoteVeryExpensive() public {
        // Testing when the remote token is much more valuable & there's a super high gas price
        setRemoteGasData(
            testDestinationDomain,
            5000 * 1e10, // 5000 exchange rate (remote token much more valuable)
            1500 * 1e9 // 1500 gwei gas price
        );

        // 300,000 destination gas
        // 1500 gwei = 1500000000000 wei
        // 300,000 * 1500000000000 = 450000000000000000 (0.45 remote eth)
        // Using the 5000 token exchange rate, meaning the remote native token
        // is 5000x more valuable than the local token:
        // 450000000000000000 * 5000 = 2250000000000000000000 (2250 local eth)
        assertEq(
            igp.quoteGasPayment(testDestinationDomain, testGasAmount),
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
            igp.quoteGasPayment(testDestinationDomain, testGasAmount),
            1200000000000
        );
    }

    function testQuoteGasPaymentRevertsIfNoGasOracleSet() public {
        uint32 _unknownDomain = 22222;

        vm.expectRevert("!gas oracle");
        igp.quoteGasPayment(_unknownDomain, testGasAmount);
    }

    // ============ setGasOracles ============

    function testSetGasOracle() public {
        uint32 _remoteDomain = 22222;

        vm.expectEmit(true, true, false, true);
        emit GasOracleSet(_remoteDomain, address(oracle));
        setGasOracle(_remoteDomain, address(oracle));

        assertEq(address(igp.gasOracles(_remoteDomain)), address(oracle));
    }

    function testSetGasOracleRevertsIfNotOwner() public {
        uint32 _remoteDomain = 22222;
        // Repurpose the refund address as a non-owner to prank as
        vm.prank(testRefundAddress);

        vm.expectRevert("Ownable: caller is not the owner");
        setGasOracle(_remoteDomain, address(oracle));
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

    // ============ claim ============

    function testClaim() public {
        setRemoteGasData(
            testDestinationDomain,
            1 * 1e10, // 1.0 exchange rate (remote token has exact same value as local)
            1 // 1 wei gas price
        );
        // Pay some funds into the IGP
        uint256 _quote = igp.quoteGasPayment(
            testDestinationDomain,
            testGasAmount
        );
        igp.payForGas{value: _quote}(
            testMessageId,
            testDestinationDomain,
            testGasAmount,
            testRefundAddress
        );

        uint256 _beneficiaryBalanceBefore = beneficiary.balance;
        igp.claim();
        uint256 _beneficiaryBalanceAfter = beneficiary.balance;

        assertEq(_beneficiaryBalanceAfter - _beneficiaryBalanceBefore, _quote);
        assertEq(address(igp).balance, 0);
    }

    // ============ getExchangeRateAndGasPrice ============

    function testGetExchangeRateAndGasPrice() public {
        // 1.0 exchange rate (remote token has exact same value as local)
        uint128 _tokenExchangeRate = 1 * 1e10;
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

        vm.expectRevert("!gas oracle");
        igp.getExchangeRateAndGasPrice(_unknownDomain);
    }

    // ============ Helper functions ============

    function setGasOracle(uint32 _remoteDomain, address _gasOracle) internal {
        InterchainGasPaymaster.GasOracleConfig[]
            memory _configs = new InterchainGasPaymaster.GasOracleConfig[](1);
        _configs[0] = InterchainGasPaymaster.GasOracleConfig({
            remoteDomain: _remoteDomain,
            gasOracle: _gasOracle
        });
        igp.setGasOracles(_configs);
    }

    function setRemoteGasData(
        uint32 _remoteDomain,
        uint128 _tokenExchangeRate,
        uint128 _gasPrice
    ) internal {
        oracle.setRemoteGasData(
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

    receive() external payable {}
}
