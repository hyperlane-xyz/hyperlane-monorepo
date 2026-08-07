// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.24;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {AbstractOffchainQuoter} from "../../libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../interfaces/IOffchainQuoter.sol";
import {TransientStorage} from "../../libs/TransientStorage.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {FeeType, TokenFeeBase} from "./BaseFee.sol";
import {FeeQuoteContext, FeeQuoteData} from "./OffchainQuotedLinearFee.sol";
import {CappedLinearFeeMath} from "./LinearFee.sol";

/**
 * @dev Standing curve data uses standard ABI encoding:
 *      abi.encode(
 *          uint128[] breakpoints,
 *          uint32[] marginalBpsX1e4,
 *          uint32 staleAfterSeconds,
 *          uint32[] staleMarginalSurchargeBpsX1e4
 *      ).
 */
library PiecewiseFeeQuoteData {
    function encode(
        uint128[] memory breakpoints,
        uint32[] memory marginalBpsX1e4,
        uint32 staleAfterSeconds,
        uint32[] memory staleMarginalSurchargeBpsX1e4
    ) internal pure returns (bytes memory) {
        return
            abi.encode(
                breakpoints,
                marginalBpsX1e4,
                staleAfterSeconds,
                staleMarginalSurchargeBpsX1e4
            );
    }

    function decode(
        bytes calldata data
    )
        internal
        pure
        returns (
            uint128[] memory breakpoints,
            uint32[] memory marginalBpsX1e4,
            uint32 staleAfterSeconds,
            uint32[] memory staleMarginalSurchargeBpsX1e4
        )
    {
        return abi.decode(data, (uint128[], uint32[], uint32, uint32[]));
    }
}

/**
 * @title OffchainQuotedPiecewiseLinearFee
 * @notice Signed marginal standing curves with age-based per-band surcharges,
 *         linear transient quotes, and a signer-mutable permanent fallback.
 * @dev Resolution cascade:
 *      transient -> (destination, recipient) -> (destination, *) ->
 *      (*, recipient) -> permanent fallback.
 *
 *      Transient quote data reuses OffchainQuotedLinearFee's packed
 *      abi.encodePacked(uint256 maxFee, uint256 halfAmount) format.
 *
 *      Curve submission is O(number of bands): it validates the curve and
 *      precomputes fresh and stale cumulative weighted fees. Transfer quoting
 *      uses eight unrolled binary-lifting probes and never loops over bands.
 */
// Domain keys are enumerated explicitly through _domainIds.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract OffchainQuotedPiecewiseLinearFee is
    AbstractOffchainQuoter,
    TokenFeeBase
{
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;
    using TransientStorage for bytes32;

    // ============ Constants ============

    uint32 constant WILDCARD_DEST = type(uint32).max;
    bytes32 constant WILDCARD_RECIPIENT = bytes32(type(uint256).max);
    uint256 constant WILDCARD_AMOUNT = type(uint256).max;

    uint256 public constant BPS_DENOMINATOR = 100_000_000;
    uint32 public constant MAX_MARGINAL_BPS_X1E4 = 100_000_000;
    uint16 public constant MAX_SUPPORTED_BANDS = 256;

    bytes32 public constant SIGNED_FALLBACK_CURVE_TYPEHASH =
        keccak256(
            "SignedFallbackCurve(bytes data,uint48 issuedAt,address submitter)"
        );

    bytes32 private constant TRANSIENT_QUOTED_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.quoted");
    bytes32 private constant TRANSIENT_DESTINATION_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.destination");
    bytes32 private constant TRANSIENT_RECIPIENT_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.recipient");
    bytes32 private constant TRANSIENT_AMOUNT_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.amount");
    bytes32 private constant TRANSIENT_MAX_FEE_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.maxFee");
    bytes32 private constant TRANSIENT_HALF_AMOUNT_SLOT =
        keccak256("OffchainQuotedPiecewiseLinearFee.halfAmount");

    // ============ Structs ============

    struct SignedFallbackCurve {
        bytes data;
        uint48 issuedAt;
        address submitter;
    }

    struct StoredCurve {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint32[] staleMarginalBpsX1e4;
        uint256[] prefixWeighted;
        uint256[] stalePrefixWeighted;
        uint32 staleAfterSeconds;
        uint48 issuedAt;
        uint48 expiry;
        bytes32 curveHash;
    }

    struct CurveQuote {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint32[] staleMarginalSurchargeBpsX1e4;
        uint32 staleAfterSeconds;
        uint48 issuedAt;
        uint48 expiry;
    }

    struct StoredFallbackCurve {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint256[] prefixWeighted;
        uint48 issuedAt;
        bytes32 curveHash;
    }

    struct FallbackCurve {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint48 issuedAt;
    }

    struct QuoteEntry {
        bytes32 recipient;
        CurveQuote quote;
    }

    // ============ Storage ============

    uint16 public immutable maxBands;

    mapping(uint32 destination => mapping(bytes32 recipient => StoredCurve))
        private _quotes;
    StoredFallbackCurve private _fallbackCurve;
    EnumerableSet.UintSet private _domainIds;
    mapping(uint32 destination => EnumerableSet.Bytes32Set recipients)
        private _recipients;

    // ============ Errors ============

    error InvalidMaxBands();
    error InvalidCurve();
    error ConflictingQuote();

    // ============ Events ============

    event FallbackCurveSubmitted(
        uint48 indexed issuedAt,
        bytes32 indexed curveHash
    );

    // ============ Constructor ============

    constructor(
        address _quoteSigner,
        address _feeToken,
        uint128[] memory _fallbackBreakpoints,
        uint32[] memory _fallbackMarginalBpsX1e4,
        uint16 _maxBands,
        address _owner
    ) TokenFeeBase(_feeToken, _owner) {
        if (_maxBands == 0 || _maxBands > MAX_SUPPORTED_BANDS) {
            revert InvalidMaxBands();
        }
        maxBands = _maxBands;

        uint256[] memory prefixes = _validateAndBuildPrefixes(
            _fallbackBreakpoints,
            _fallbackMarginalBpsX1e4,
            true
        );
        _fallbackCurve.breakpoints = _fallbackBreakpoints;
        _fallbackCurve.marginalBpsX1e4 = _fallbackMarginalBpsX1e4;
        _fallbackCurve.prefixWeighted = prefixes;
        _fallbackCurve.curveHash = keccak256(
            abi.encode(_fallbackBreakpoints, _fallbackMarginalBpsX1e4)
        );

        _addQuoteSigner(_quoteSigner);
    }

    // ============ Owner ============

    function addQuoteSigner(address _signer) external onlyOwner {
        _addQuoteSigner(_signer);
    }

    function removeQuoteSigner(address _signer) external onlyOwner {
        _removeQuoteSigner(_signer);
    }

    // ============ ITokenFee ============

    function feeType() external pure override returns (FeeType) {
        return FeeType.OFFCHAIN_QUOTED_PIECEWISE_LINEAR;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory) {
        if (_matchesTransient(_destination, _recipient, _amount)) {
            return
                _singleQuote(
                    CappedLinearFeeMath.compute(
                        TRANSIENT_MAX_FEE_SLOT.loadUint256(),
                        TRANSIENT_HALF_AMOUNT_SLOT.loadUint256(),
                        _amount
                    )
                );
        }

        (bool found, uint256 fee) = _resolveStored(
            _quotes[_destination][_recipient],
            _amount
        );
        if (found) return _singleQuote(fee);

        (found, fee) = _resolveStored(
            _quotes[_destination][WILDCARD_RECIPIENT],
            _amount
        );
        if (found) return _singleQuote(fee);

        (found, fee) = _resolveStored(
            _quotes[WILDCARD_DEST][_recipient],
            _amount
        );
        if (found) return _singleQuote(fee);

        return
            _singleQuote(
                _computeCurveFee(
                    _fallbackCurve.breakpoints,
                    _fallbackCurve.marginalBpsX1e4,
                    _fallbackCurve.prefixWeighted,
                    _amount
                )
            );
    }

    // ============ Fallback Submission ============

    function submitFallbackCurve(
        SignedFallbackCurve calldata update,
        bytes calldata signature
    ) external {
        if (update.submitter == address(0) || update.submitter != msg.sender) {
            revert InvalidSubmitter();
        }
        if (update.issuedAt > uint48(block.timestamp)) revert InvalidQuote();

        bytes32 structHash = keccak256(
            abi.encode(
                SIGNED_FALLBACK_CURVE_TYPEHASH,
                keccak256(update.data),
                update.issuedAt,
                update.submitter
            )
        );
        _verifyQuoteSigner(structHash, signature);

        bytes32 curveHash = keccak256(update.data);
        if (update.issuedAt < _fallbackCurve.issuedAt) revert StaleQuote();
        if (update.issuedAt == _fallbackCurve.issuedAt) {
            if (curveHash == _fallbackCurve.curveHash) return;
            revert ConflictingQuote();
        }

        (uint128[] memory breakpoints, uint32[] memory marginalBpsX1e4) = abi
            .decode(update.data, (uint128[], uint32[]));
        uint256[] memory prefixes = _validateAndBuildPrefixes(
            breakpoints,
            marginalBpsX1e4,
            true
        );

        _fallbackCurve.breakpoints = breakpoints;
        _fallbackCurve.marginalBpsX1e4 = marginalBpsX1e4;
        _fallbackCurve.prefixWeighted = prefixes;
        _fallbackCurve.issuedAt = update.issuedAt;
        _fallbackCurve.curveHash = curveHash;

        emit FallbackCurveSubmitted(update.issuedAt, curveHash);
    }

    // ============ Inspection ============

    function getCurve(
        uint32 destination,
        bytes32 recipient
    ) public view returns (CurveQuote memory result) {
        StoredCurve storage stored = _quotes[destination][recipient];
        uint256 length = stored.marginalBpsX1e4.length;
        uint32[] memory surcharges = new uint32[](length);
        for (uint256 i = 0; i < length; ++i) {
            surcharges[i] =
                stored.staleMarginalBpsX1e4[i] -
                stored.marginalBpsX1e4[i];
        }
        result = CurveQuote({
            breakpoints: stored.breakpoints,
            marginalBpsX1e4: stored.marginalBpsX1e4,
            staleMarginalSurchargeBpsX1e4: surcharges,
            staleAfterSeconds: stored.staleAfterSeconds,
            issuedAt: stored.issuedAt,
            expiry: stored.expiry
        });
    }

    function getFallbackCurve() external view returns (FallbackCurve memory) {
        return
            FallbackCurve({
                breakpoints: _fallbackCurve.breakpoints,
                marginalBpsX1e4: _fallbackCurve.marginalBpsX1e4,
                issuedAt: _fallbackCurve.issuedAt
            });
    }

    /// @notice Returns exact domain keys with at least one standing curve.
    /// @dev Entries are never pruned and may all be expired. Order unspecified.
    function quoteDomains() external view returns (uint32[] memory domains) {
        uint256 length = _domainIds.length();
        domains = new uint32[](length);
        for (uint256 i = 0; i < length; ++i) {
            domains[i] = uint32(_domainIds.at(i));
        }
    }

    /// @notice Returns all raw standing curves under an exact domain key.
    /// @dev Offchain inspection only. Unbounded and may include expired curves.
    function getQuotesForDomain(
        uint32 destination
    ) external view returns (QuoteEntry[] memory entries) {
        EnumerableSet.Bytes32Set storage recipients = _recipients[destination];
        uint256 length = recipients.length();
        entries = new QuoteEntry[](length);
        for (uint256 i = 0; i < length; ++i) {
            bytes32 recipient = recipients.at(i);
            entries[i] = QuoteEntry({
                recipient: recipient,
                quote: getCurve(destination, recipient)
            });
        }
    }

    // ============ AbstractOffchainQuoter ============

    function _storeTransient(SignedQuote calldata sq) internal override {
        (
            uint32 destination,
            bytes32 recipient,
            uint256 amount
        ) = FeeQuoteContext.decode(sq.context);
        (uint256 maxFee_, uint256 halfAmount_) = FeeQuoteData.decode(sq.data);

        TRANSIENT_QUOTED_SLOT.set();
        TRANSIENT_DESTINATION_SLOT.store(destination);
        TRANSIENT_RECIPIENT_SLOT.store(recipient);
        TRANSIENT_AMOUNT_SLOT.store(amount);
        TRANSIENT_MAX_FEE_SLOT.store(maxFee_);
        TRANSIENT_HALF_AMOUNT_SLOT.store(halfAmount_);
    }

    function _storeStanding(
        SignedQuote calldata sq
    ) internal override returns (bool) {
        (
            uint32 destination,
            bytes32 recipient,
            uint256 amount
        ) = FeeQuoteContext.decode(sq.context);
        if (amount != WILDCARD_AMOUNT) revert InvalidCurve();

        bytes32 curveHash = keccak256(
            abi.encode(keccak256(sq.data), sq.expiry)
        );
        StoredCurve storage existing = _quotes[destination][recipient];
        if (sq.issuedAt < existing.issuedAt) revert StaleQuote();
        if (sq.issuedAt == existing.issuedAt) {
            if (curveHash == existing.curveHash) return false;
            revert ConflictingQuote();
        }

        (
            uint128[] memory breakpoints,
            uint32[] memory marginalBpsX1e4,
            uint32 staleAfterSeconds,
            uint32[] memory staleSurcharges
        ) = PiecewiseFeeQuoteData.decode(sq.data);
        if (
            staleAfterSeconds == 0 ||
            uint256(sq.issuedAt) + staleAfterSeconds > sq.expiry
        ) revert InvalidCurve();

        uint256[] memory prefixes = _validateAndBuildPrefixes(
            breakpoints,
            marginalBpsX1e4,
            false
        );
        (
            uint32[] memory staleRates,
            uint256[] memory stalePrefixes
        ) = _validateAndBuildStaleCurve(
                breakpoints,
                marginalBpsX1e4,
                staleSurcharges
            );

        existing.breakpoints = breakpoints;
        existing.marginalBpsX1e4 = marginalBpsX1e4;
        existing.staleMarginalBpsX1e4 = staleRates;
        existing.prefixWeighted = prefixes;
        existing.stalePrefixWeighted = stalePrefixes;
        existing.staleAfterSeconds = staleAfterSeconds;
        existing.issuedAt = sq.issuedAt;
        existing.expiry = sq.expiry;
        existing.curveHash = curveHash;

        _domainIds.add(destination);
        _recipients[destination].add(recipient);
        return true;
    }

    // ============ Curve Validation ============

    function _validateAndBuildPrefixes(
        uint128[] memory breakpoints,
        uint32[] memory marginalBpsX1e4,
        bool requirePositive
    ) internal view returns (uint256[] memory prefixWeighted) {
        uint256 bandCount = marginalBpsX1e4.length;
        if (
            bandCount == 0 ||
            bandCount > maxBands ||
            breakpoints.length + 1 != bandCount ||
            (requirePositive && marginalBpsX1e4[bandCount - 1] == 0)
        ) revert InvalidCurve();

        prefixWeighted = new uint256[](bandCount);
        uint128 previousBreakpoint;
        uint32 previousRate;

        for (uint256 i = 0; i < bandCount; ++i) {
            uint32 rate = marginalBpsX1e4[i];
            if (rate > MAX_MARGINAL_BPS_X1E4 || (i > 0 && rate < previousRate))
                revert InvalidCurve();

            if (i < breakpoints.length) {
                uint128 breakpoint = breakpoints[i];
                if (breakpoint == 0 || breakpoint <= previousBreakpoint) {
                    revert InvalidCurve();
                }
                prefixWeighted[i + 1] =
                    prefixWeighted[i] +
                    uint256(breakpoint - previousBreakpoint) *
                    rate;
                previousBreakpoint = breakpoint;
            }
            previousRate = rate;
        }
    }

    function _validateAndBuildStaleCurve(
        uint128[] memory breakpoints,
        uint32[] memory marginalBpsX1e4,
        uint32[] memory surcharges
    )
        internal
        view
        returns (uint32[] memory staleRates, uint256[] memory stalePrefixes)
    {
        uint256 bandCount = marginalBpsX1e4.length;
        if (surcharges.length != bandCount) revert InvalidCurve();

        staleRates = new uint32[](bandCount);
        uint32 previousSurcharge;
        for (uint256 i = 0; i < bandCount; ++i) {
            uint32 surcharge = surcharges[i];
            uint256 staleRate = uint256(marginalBpsX1e4[i]) + surcharge;
            if (
                (i > 0 && surcharge < previousSurcharge) ||
                staleRate > MAX_MARGINAL_BPS_X1E4
            ) revert InvalidCurve();
            staleRates[i] = uint32(staleRate);
            previousSurcharge = surcharge;
        }
        stalePrefixes = _validateAndBuildPrefixes(
            breakpoints,
            staleRates,
            false
        );
    }

    // ============ Curve Resolution ============

    function _matchesTransient(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) private view returns (bool) {
        if (!TRANSIENT_QUOTED_SLOT.loadBool()) return false;

        uint32 quotedDestination = TRANSIENT_DESTINATION_SLOT.loadUint32();
        if (
            quotedDestination != WILDCARD_DEST &&
            quotedDestination != destination
        ) return false;

        bytes32 quotedRecipient = TRANSIENT_RECIPIENT_SLOT.loadBytes32();
        if (
            quotedRecipient != WILDCARD_RECIPIENT &&
            quotedRecipient != recipient
        ) return false;

        uint256 quotedAmount = TRANSIENT_AMOUNT_SLOT.loadUint256();
        return quotedAmount == WILDCARD_AMOUNT || quotedAmount == amount;
    }

    function _resolveStored(
        StoredCurve storage curve,
        uint256 amount
    ) private view returns (bool, uint256) {
        if (curve.expiry == 0 || uint48(block.timestamp) > curve.expiry) {
            return (false, 0);
        }
        bool stale = block.timestamp >=
            uint256(curve.issuedAt) + curve.staleAfterSeconds;
        return
            stale
                ? (
                    true,
                    _computeCurveFee(
                        curve.breakpoints,
                        curve.staleMarginalBpsX1e4,
                        curve.stalePrefixWeighted,
                        amount
                    )
                )
                : (
                    true,
                    _computeCurveFee(
                        curve.breakpoints,
                        curve.marginalBpsX1e4,
                        curve.prefixWeighted,
                        amount
                    )
                );
    }

    function _computeCurveFee(
        uint128[] storage breakpoints,
        uint32[] storage rates,
        uint256[] storage prefixes,
        uint256 amount
    ) private view returns (uint256) {
        uint256 band;
        band = _advanceStored(breakpoints, rates.length, amount, band, 128);
        band = _advanceStored(breakpoints, rates.length, amount, band, 64);
        band = _advanceStored(breakpoints, rates.length, amount, band, 32);
        band = _advanceStored(breakpoints, rates.length, amount, band, 16);
        band = _advanceStored(breakpoints, rates.length, amount, band, 8);
        band = _advanceStored(breakpoints, rates.length, amount, band, 4);
        band = _advanceStored(breakpoints, rates.length, amount, band, 2);
        band = _advanceStored(breakpoints, rates.length, amount, band, 1);

        uint256 start = band == 0 ? 0 : breakpoints[band - 1];
        return _computeMarginalFee(prefixes[band], amount - start, rates[band]);
    }

    function _advanceStored(
        uint128[] storage breakpoints,
        uint256 bandCount,
        uint256 amount,
        uint256 band,
        uint256 step
    ) private view returns (uint256) {
        uint256 candidate = band + step;
        if (candidate < bandCount && amount > breakpoints[candidate - 1])
            return candidate;
        return band;
    }

    function _computeMarginalFee(
        uint256 prefixWeighted,
        uint256 amountInBand,
        uint32 marginalBpsX1e4
    ) private pure returns (uint256) {
        uint256 prefixQuotient = prefixWeighted / BPS_DENOMINATOR;
        uint256 prefixRemainder = prefixWeighted % BPS_DENOMINATOR;
        uint256 marginalQuotient = Math.mulDiv(
            amountInBand,
            marginalBpsX1e4,
            BPS_DENOMINATOR
        );
        uint256 marginalRemainder = mulmod(
            amountInBand,
            marginalBpsX1e4,
            BPS_DENOMINATOR
        );
        return
            prefixQuotient +
            marginalQuotient +
            (prefixRemainder + marginalRemainder) /
            BPS_DENOMINATOR;
    }

    function _singleQuote(
        uint256 fee
    ) private view returns (Quote[] memory result) {
        result = new Quote[](1);
        result[0] = Quote(address(token), fee);
    }
}
