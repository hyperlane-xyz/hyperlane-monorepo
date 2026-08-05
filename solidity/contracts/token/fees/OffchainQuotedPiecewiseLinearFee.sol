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
import {FeeType} from "./BaseFee.sol";
import {FeeQuoteContext, FeeQuoteData} from "./OffchainQuotedLinearFee.sol";
import {LinearFee} from "./LinearFee.sol";

/**
 * @dev Piecewise fee data uses standard ABI encoding:
 *      abi.encode(uint128[] breakpoints, uint32[] marginalBpsX1e4).
 *      There is one more marginal rate than breakpoint. The last rate is
 *      open-ended. One basis point is encoded as 10_000.
 */
library PiecewiseFeeQuoteData {
    function encode(
        uint128[] memory breakpoints,
        uint32[] memory marginalBpsX1e4
    ) internal pure returns (bytes memory) {
        return abi.encode(breakpoints, marginalBpsX1e4);
    }

    function decode(
        bytes calldata data
    )
        internal
        pure
        returns (uint128[] memory breakpoints, uint32[] memory marginalBpsX1e4)
    {
        return abi.decode(data, (uint128[], uint32[]));
    }
}

/**
 * @title OffchainQuotedPiecewiseLinearFee
 * @notice Signed marginal standing curves with linear transient quotes and an
 *         immutable LinearFee fallback.
 * @dev Resolution cascade:
 *      transient -> (destination, recipient) -> (destination, *) ->
 *      (*, recipient) -> immutable LinearFee fallback.
 *
 *      Transient quote data reuses OffchainQuotedLinearFee's packed
 *      abi.encodePacked(uint256 maxFee, uint256 halfAmount) format. Standing
 *      quote data uses PiecewiseFeeQuoteData.
 *
 *      Curve submission is O(number of bands): it validates the curve and
 *      precomputes cumulative weighted fees. Transfer quoting uses eight
 *      unrolled binary-lifting probes and never loops over active bands.
 */
// Domain keys are enumerated explicitly through _domainIds.
// solhint-disable-next-line hyperlane/enumerable-domain-mapping
contract OffchainQuotedPiecewiseLinearFee is AbstractOffchainQuoter, LinearFee {
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

    struct StoredCurve {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint256[] prefixWeighted;
        uint48 issuedAt;
        uint48 expiry;
    }

    struct CurveQuote {
        uint128[] breakpoints;
        uint32[] marginalBpsX1e4;
        uint48 issuedAt;
        uint48 expiry;
    }

    struct QuoteEntry {
        bytes32 recipient;
        CurveQuote quote;
    }

    // ============ Storage ============

    uint16 public immutable maxBands;

    mapping(uint32 destination => mapping(bytes32 recipient => StoredCurve))
        private _quotes;
    EnumerableSet.UintSet private _domainIds;
    mapping(uint32 destination => EnumerableSet.Bytes32Set recipients)
        private _recipients;

    // ============ Errors ============

    error InvalidMaxBands();
    error InvalidCurve();

    // ============ Constructor ============

    constructor(
        address _quoteSigner,
        address _feeToken,
        uint256 _fallbackMaxFee,
        uint256 _fallbackHalfAmount,
        uint16 _maxBands,
        address _owner
    ) LinearFee(_feeToken, _fallbackMaxFee, _fallbackHalfAmount, _owner) {
        if (_maxBands == 0 || _maxBands > MAX_SUPPORTED_BANDS) {
            revert InvalidMaxBands();
        }
        maxBands = _maxBands;
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
                    _computeLinearFee(
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

        return _singleQuote(_computeLinearFee(maxFee, halfAmount, _amount));
    }

    // ============ Inspection ============

    function getCurve(
        uint32 destination,
        bytes32 recipient
    ) public view returns (CurveQuote memory) {
        StoredCurve storage stored = _quotes[destination][recipient];
        return
            CurveQuote({
                breakpoints: stored.breakpoints,
                marginalBpsX1e4: stored.marginalBpsX1e4,
                issuedAt: stored.issuedAt,
                expiry: stored.expiry
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

        StoredCurve storage existing = _quotes[destination][recipient];
        if (sq.issuedAt < existing.issuedAt) revert StaleQuote();
        if (sq.issuedAt == existing.issuedAt) return false;

        (
            uint128[] memory breakpoints,
            uint32[] memory marginalBpsX1e4
        ) = PiecewiseFeeQuoteData.decode(sq.data);
        uint256[] memory prefixWeighted = _validateAndBuildPrefixes(
            breakpoints,
            marginalBpsX1e4
        );

        existing.breakpoints = breakpoints;
        existing.marginalBpsX1e4 = marginalBpsX1e4;
        existing.prefixWeighted = prefixWeighted;
        existing.issuedAt = sq.issuedAt;
        existing.expiry = sq.expiry;

        _domainIds.add(destination);
        _recipients[destination].add(recipient);
        return true;
    }

    // ============ Curve Validation ============

    function _validateAndBuildPrefixes(
        uint128[] memory breakpoints,
        uint32[] memory marginalBpsX1e4
    ) internal view returns (uint256[] memory prefixWeighted) {
        uint256 bandCount = marginalBpsX1e4.length;
        if (
            bandCount == 0 ||
            bandCount > maxBands ||
            breakpoints.length + 1 != bandCount
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
        return (true, _computeStoredFee(curve, amount));
    }

    function _computeStoredFee(
        StoredCurve storage curve,
        uint256 amount
    ) private view returns (uint256) {
        uint256 band;
        band = _advanceStored(curve, amount, band, 128);
        band = _advanceStored(curve, amount, band, 64);
        band = _advanceStored(curve, amount, band, 32);
        band = _advanceStored(curve, amount, band, 16);
        band = _advanceStored(curve, amount, band, 8);
        band = _advanceStored(curve, amount, band, 4);
        band = _advanceStored(curve, amount, band, 2);
        band = _advanceStored(curve, amount, band, 1);

        uint256 start = band == 0 ? 0 : curve.breakpoints[band - 1];
        return
            _computeMarginalFee(
                curve.prefixWeighted[band],
                amount - start,
                curve.marginalBpsX1e4[band]
            );
    }

    function _advanceStored(
        StoredCurve storage curve,
        uint256 amount,
        uint256 band,
        uint256 step
    ) private view returns (uint256) {
        uint256 candidate = band + step;
        if (
            candidate < curve.marginalBpsX1e4.length &&
            amount > curve.breakpoints[candidate - 1]
        ) return candidate;
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
