// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AbstractOffchainQuoter} from "../../contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../contracts/interfaces/IOffchainQuoter.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {FeeType} from "../../contracts/token/fees/BaseFee.sol";
import {OffchainQuotedPiecewiseLinearFee} from "../../contracts/token/fees/OffchainQuotedPiecewiseLinearFee.sol";

contract OffchainQuotedPiecewiseLinearFeeTest is Test {
    uint256 internal constant SIGNER_KEY = 0xA11CE;
    address internal constant FEE_TOKEN = address(0xFEE);
    uint32 internal constant DESTINATION = 42;
    bytes32 internal constant RECIPIENT = bytes32(uint256(0xBEEF));
    uint32 internal constant WILDCARD_DESTINATION = type(uint32).max;
    bytes32 internal constant WILDCARD_RECIPIENT = bytes32(type(uint256).max);
    uint256 internal constant WILDCARD_AMOUNT = type(uint256).max;

    uint256 internal constant FALLBACK_MAX_FEE = 0.02 ether;
    uint256 internal constant FALLBACK_HALF_AMOUNT = 1 ether;
    uint256 internal constant DENOMINATOR = 100_000_000;
    bytes32 internal constant SIGNED_QUOTE_TYPEHASH =
        keccak256(
            "SignedQuote(bytes context,bytes data,uint48 issuedAt,uint48 expiry,bytes32 salt,address submitter)"
        );

    address internal signer;
    OffchainQuotedPiecewiseLinearFee internal quotedFee;

    function setUp() public {
        signer = vm.addr(SIGNER_KEY);
        quotedFee = _deploy(4);
    }

    function _deploy(
        uint16 maxBands
    ) internal returns (OffchainQuotedPiecewiseLinearFee) {
        return
            new OffchainQuotedPiecewiseLinearFee(
                signer,
                FEE_TOKEN,
                FALLBACK_MAX_FEE,
                FALLBACK_HALF_AMOUNT,
                maxBands,
                signer
            );
    }

    function _domainSeparator(
        OffchainQuotedPiecewiseLinearFee fee
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("OffchainQuoter"),
                    keccak256("1"),
                    block.chainid,
                    address(fee)
                )
            );
    }

    function _signQuote(
        OffchainQuotedPiecewiseLinearFee fee,
        SignedQuote memory signedQuote
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SIGNED_QUOTE_TYPEHASH,
                keccak256(signedQuote.context),
                keccak256(signedQuote.data),
                signedQuote.issuedAt,
                signedQuote.expiry,
                signedQuote.salt,
                signedQuote.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(
            _domainSeparator(fee),
            structHash
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _context(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(destination, recipient, amount);
    }

    function _curveData(
        uint128[] memory breakpoints,
        uint32[] memory rates
    ) internal pure returns (bytes memory) {
        return abi.encode(breakpoints, rates);
    }

    function _submitData(
        OffchainQuotedPiecewiseLinearFee fee,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        bytes memory data,
        uint48 issuedAt,
        uint48 expiry
    ) internal {
        SignedQuote memory signedQuote = SignedQuote({
            context: _context(destination, recipient, amount),
            data: data,
            issuedAt: issuedAt,
            expiry: expiry,
            salt: bytes32(0),
            submitter: address(0)
        });
        fee.submitQuote(signedQuote, _signQuote(fee, signedQuote));
    }

    function _submitCurve(
        OffchainQuotedPiecewiseLinearFee fee,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        uint128[] memory breakpoints,
        uint32[] memory rates,
        uint48 issuedAt,
        uint48 expiry
    ) internal {
        _submitData(
            fee,
            destination,
            recipient,
            amount,
            _curveData(breakpoints, rates),
            issuedAt,
            expiry
        );
    }

    function _submitLinearTransient(
        OffchainQuotedPiecewiseLinearFee fee,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        uint256 maxFee,
        uint256 halfAmount
    ) internal {
        uint48 now_ = uint48(block.timestamp);
        _submitData(
            fee,
            destination,
            recipient,
            amount,
            abi.encodePacked(maxFee, halfAmount),
            now_,
            now_
        );
    }

    function _submitStanding(
        uint32 destination,
        bytes32 recipient,
        uint128[] memory breakpoints,
        uint32[] memory rates
    ) internal {
        uint48 now_ = uint48(block.timestamp);
        _submitCurve(
            quotedFee,
            destination,
            recipient,
            WILDCARD_AMOUNT,
            breakpoints,
            rates,
            now_,
            now_ + 1 days
        );
    }

    function _quote(
        OffchainQuotedPiecewiseLinearFee fee,
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) internal view returns (uint256) {
        Quote[] memory quotes = fee.quoteTransferRemote(
            destination,
            recipient,
            amount
        );
        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, FEE_TOKEN);
        return quotes[0].amount;
    }

    function _fallbackFee(uint256 amount) internal pure returns (uint256) {
        uint256 uncapped = (amount * FALLBACK_MAX_FEE) /
            (2 * FALLBACK_HALF_AMOUNT);
        return uncapped > FALLBACK_MAX_FEE ? FALLBACK_MAX_FEE : uncapped;
    }

    function _exampleCurve()
        internal
        pure
        returns (uint128[] memory breakpoints, uint32[] memory rates)
    {
        breakpoints = new uint128[](2);
        breakpoints[0] = 100_000 ether;
        breakpoints[1] = 250_000 ether;
        rates = new uint32[](3);
        rates[0] = 10_000; // 1 bp
        rates[1] = 40_000; // 4 bps
        rates[2] = 120_000; // 12 bps
    }

    function _referenceFee(
        uint128[] memory breakpoints,
        uint32[] memory rates,
        uint256 amount
    ) internal pure returns (uint256) {
        uint256 weighted;
        uint256 start;
        for (uint256 i = 0; i < rates.length; ++i) {
            uint256 end = i < breakpoints.length ? breakpoints[i] : amount;
            if (amount <= start) break;
            if (end > amount) end = amount;
            weighted += (end - start) * rates[i];
            if (amount <= end) break;
            start = end;
        }
        return weighted / DENOMINATOR;
    }

    // ============ Constructor and type ============

    function test_constructorAndFeeType() public view {
        assertEq(quotedFee.maxBands(), 4);
        assertEq(
            uint8(quotedFee.feeType()),
            uint8(FeeType.OFFCHAIN_QUOTED_PIECEWISE_LINEAR)
        );
    }

    function test_constructorRejectsInvalidMaxBands() public {
        vm.expectRevert(
            OffchainQuotedPiecewiseLinearFee.InvalidMaxBands.selector
        );
        _deploy(0);

        vm.expectRevert(
            OffchainQuotedPiecewiseLinearFee.InvalidMaxBands.selector
        );
        _deploy(257);
    }

    // ============ Fee calculation ============

    function test_exampleMarginalCurve() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, WILDCARD_RECIPIENT, breakpoints, rates);

        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 100_000 ether),
            10 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 200_000 ether),
            50 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 300_000 ether),
            130 ether
        );
    }

    function test_breakpointContinuity() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);

        uint256 atFirst = _quote(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            breakpoints[0]
        );
        uint256 afterFirst = _quote(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            uint256(breakpoints[0]) + 1
        );
        assertEq(atFirst, 10 ether);
        assertEq(afterFirst, atFirst);

        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, breakpoints[1]),
            70 ether
        );
    }

    function test_zeroFeeCurve() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory rates = new uint32[](1);
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, type(uint256).max),
            0
        );
    }

    function test_fullRateHandlesMaxAmount() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory rates = new uint32[](1);
        rates[0] = 100_000_000;
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, type(uint256).max),
            type(uint256).max
        );
    }

    function test_maximumBandCount() public {
        OffchainQuotedPiecewiseLinearFee maxFeeContract = _deploy(256);
        uint128[] memory breakpoints = new uint128[](255);
        uint32[] memory rates = new uint32[](256);
        for (uint256 i = 0; i < rates.length; ++i) {
            rates[i] = 10_000;
            if (i < breakpoints.length) {
                breakpoints[i] = uint128((i + 1) * 1 ether);
            }
        }

        uint48 now_ = uint48(block.timestamp);
        _submitCurve(
            maxFeeContract,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            breakpoints,
            rates,
            now_,
            now_ + 1 days
        );
        assertEq(
            _quote(maxFeeContract, DESTINATION, RECIPIENT, 300 ether),
            0.03 ether
        );
    }

    function testFuzz_feeMatchesReference(uint128 amount) public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, amount),
            _referenceFee(breakpoints, rates, amount)
        );
    }

    // ============ Resolution ============

    function test_resolutionPriorityAndFallback() public {
        uint128[] memory noBreakpoints = new uint128[](0);
        uint32[] memory oneBp = new uint32[](1);
        oneBp[0] = 10_000;
        uint32[] memory twoBps = new uint32[](1);
        twoBps[0] = 20_000;

        _submitStanding(DESTINATION, WILDCARD_RECIPIENT, noBreakpoints, oneBp);
        vm.warp(block.timestamp + 1);
        _submitStanding(DESTINATION, RECIPIENT, noBreakpoints, twoBps);

        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 1 ether),
            0.0002 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, bytes32(uint256(0xCAFE)), 1 ether),
            0.0001 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION + 1, RECIPIENT, 1 ether),
            _fallbackFee(1 ether)
        );
    }

    function test_expiredCurveUsesFallback() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 1 ether),
            _fallbackFee(1 ether)
        );
    }

    function test_transientLinearExactAndWildcardAmount() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);

        _submitLinearTransient(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            300_000 ether,
            260 ether,
            300_000 ether
        );

        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 300_000 ether),
            130 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 200_000 ether),
            50 ether
        );

        _submitLinearTransient(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            100 ether,
            100_000 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 200_000 ether),
            100 ether
        );
    }

    function test_transientLinearOverridesStandingCurve() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory rates = new uint32[](1);
        rates[0] = 10_000;
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 1 ether),
            0.0001 ether
        );

        _submitLinearTransient(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            1 ether,
            0.0004 ether,
            1 ether
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 1 ether),
            0.0002 ether
        );
    }

    function test_transientLinearSupportsContextWildcards() public {
        _submitLinearTransient(
            quotedFee,
            WILDCARD_DESTINATION,
            WILDCARD_RECIPIENT,
            WILDCARD_AMOUNT,
            2 ether,
            1 ether
        );

        assertEq(
            _quote(
                quotedFee,
                DESTINATION + 1,
                bytes32(uint256(0xCAFE)),
                1 ether
            ),
            1 ether
        );
    }

    function test_transientLinearSupportsZeroFee() public {
        _submitLinearTransient(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            1 ether,
            0,
            1
        );
        assertEq(_quote(quotedFee, DESTINATION, RECIPIENT, 1 ether), 0);
    }

    function test_rejectsCurveDataForTransientQuote() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        uint48 now_ = uint48(block.timestamp);
        vm.expectRevert();
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            1 ether,
            breakpoints,
            rates,
            now_,
            now_
        );
    }

    function test_rejectsLinearDataForStandingQuote() public {
        uint48 now_ = uint48(block.timestamp);
        vm.expectRevert();
        _submitData(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            abi.encodePacked(uint256(1 ether), uint256(1 ether)),
            now_,
            now_ + 1 days
        );
    }

    // ============ Validation and replacement ============

    function test_rejectsNonWildcardStandingAmount() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory rates = new uint32[](1);
        uint48 now_ = uint48(block.timestamp);
        vm.expectRevert(OffchainQuotedPiecewiseLinearFee.InvalidCurve.selector);
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            1 ether,
            breakpoints,
            rates,
            now_,
            now_ + 1 days
        );
    }

    function test_rejectsMalformedCurves() public {
        uint128[] memory noBreakpoints = new uint128[](0);
        uint32[] memory noRates = new uint32[](0);
        _expectInvalidCurve(noBreakpoints, noRates);

        uint128[] memory oneBreakpoint = new uint128[](1);
        oneBreakpoint[0] = 1 ether;
        uint32[] memory oneRate = new uint32[](1);
        oneRate[0] = 10_000;
        _expectInvalidCurve(oneBreakpoint, oneRate);

        uint128[] memory twoBreakpoints = new uint128[](2);
        twoBreakpoints[0] = 2 ether;
        twoBreakpoints[1] = 1 ether;
        uint32[] memory threeRates = new uint32[](3);
        threeRates[0] = 10_000;
        threeRates[1] = 20_000;
        threeRates[2] = 30_000;
        _expectInvalidCurve(twoBreakpoints, threeRates);

        twoBreakpoints[0] = 1 ether;
        twoBreakpoints[1] = 2 ether;
        threeRates[0] = 20_000;
        threeRates[1] = 10_000;
        _expectInvalidCurve(twoBreakpoints, threeRates);

        threeRates[0] = 10_000;
        threeRates[1] = 20_000;
        threeRates[2] = 100_000_001;
        _expectInvalidCurve(twoBreakpoints, threeRates);
    }

    function test_rejectsMoreThanConfiguredBands() public {
        uint128[] memory breakpoints = new uint128[](4);
        uint32[] memory rates = new uint32[](5);
        for (uint256 i = 0; i < breakpoints.length; ++i) {
            breakpoints[i] = uint128((i + 1) * 1 ether);
        }
        _expectInvalidCurve(breakpoints, rates);
    }

    function _expectInvalidCurve(
        uint128[] memory breakpoints,
        uint32[] memory rates
    ) internal {
        uint48 now_ = uint48(block.timestamp);
        vm.expectRevert(OffchainQuotedPiecewiseLinearFee.InvalidCurve.selector);
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            breakpoints,
            rates,
            now_,
            now_ + 1 days
        );
    }

    function test_rejectsFutureStandingIssuedAt() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory rates = new uint32[](1);
        uint48 future = uint48(block.timestamp) + 1;
        vm.expectRevert(AbstractOffchainQuoter.InvalidQuote.selector);
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            breakpoints,
            rates,
            future,
            future + 1 days
        );
    }

    function test_replacesOnlyWithNewerIssuedAt() public {
        uint128[] memory breakpoints = new uint128[](0);
        uint32[] memory oneBp = new uint32[](1);
        oneBp[0] = 10_000;
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, oneBp);

        uint32[] memory twoBps = new uint32[](1);
        twoBps[0] = 20_000;
        uint48 now_ = uint48(block.timestamp);
        vm.expectRevert(AbstractOffchainQuoter.StaleQuote.selector);
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            breakpoints,
            twoBps,
            now_ - 1,
            now_ + 1 days
        );

        vm.warp(block.timestamp + 1);
        uint48 later = uint48(block.timestamp);
        _submitCurve(
            quotedFee,
            DESTINATION,
            RECIPIENT,
            WILDCARD_AMOUNT,
            breakpoints,
            twoBps,
            later,
            later + 1 days
        );
        assertEq(
            _quote(quotedFee, DESTINATION, RECIPIENT, 1 ether),
            0.0002 ether
        );
    }

    // ============ Inspection ============

    function test_enumeratesStandingCurvesOnly() public {
        (uint128[] memory breakpoints, uint32[] memory rates) = _exampleCurve();
        _submitStanding(DESTINATION, RECIPIENT, breakpoints, rates);

        uint32[] memory domains = quotedFee.quoteDomains();
        assertEq(domains.length, 1);
        assertEq(domains[0], DESTINATION);

        OffchainQuotedPiecewiseLinearFee.QuoteEntry[] memory entries = quotedFee
            .getQuotesForDomain(DESTINATION);
        assertEq(entries.length, 1);
        assertEq(entries[0].recipient, RECIPIENT);
        assertEq(entries[0].quote.breakpoints.length, breakpoints.length);
        assertEq(entries[0].quote.marginalBpsX1e4.length, rates.length);
        for (uint256 i = 0; i < breakpoints.length; ++i) {
            assertEq(entries[0].quote.breakpoints[i], breakpoints[i]);
        }
        for (uint256 i = 0; i < rates.length; ++i) {
            assertEq(entries[0].quote.marginalBpsX1e4[i], rates[i]);
        }

        _submitLinearTransient(
            quotedFee,
            DESTINATION + 1,
            RECIPIENT,
            WILDCARD_AMOUNT,
            1 ether,
            1 ether
        );
        assertEq(quotedFee.quoteDomains().length, 1);
    }
}
