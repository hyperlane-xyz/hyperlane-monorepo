// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract InterchainGasPaymasterTest is Test {
    using StandardHookMetadata for bytes;
    using TypeCasts for address;
    using MessageUtils for bytes;

    InterchainGasPaymaster igp;
    StorageGasOracle testOracle;

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

        vm.expectRevert("Configured IGP doesn't support domain 22222");
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
            uint8(IPostDispatchHook.Types.INTERCHAIN_GAS_PAYMASTER)
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

    // ============ Helper functions ============

    function setTestDestinationGasConfig(
        uint32 _remoteDomain,
        IGasOracle _gasOracle,
        uint96 _gasOverhead
    ) internal {
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](1);

        params[0] = InterchainGasPaymaster.GasParam(
            _remoteDomain,
            InterchainGasPaymaster.DomainGasConfig(_gasOracle, _gasOverhead)
        );
        igp.setDestinationGasConfigs(params);
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

    receive() external payable {}
}
