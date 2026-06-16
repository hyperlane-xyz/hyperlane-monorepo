// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {AbstractOffchainQuoter} from "../../libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../interfaces/IOffchainQuoter.sol";
import {TransientStorage} from "../../libs/TransientStorage.sol";
import {Quote} from "../../interfaces/ITokenBridge.sol";
import {LinearFee} from "./LinearFee.sol";
import {FeeType} from "./BaseFee.sol";

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @dev Fee quote context layout (packed, 68 bytes):
 *
 * [0:4]    Destination domain (uint32)
 * [4:36]   Recipient address (bytes32)
 * [36:68]  Transfer amount (uint256)
 */
library FeeQuoteContext {
    uint256 private constant OFFSET_DESTINATION = 0;
    uint256 private constant OFFSET_RECIPIENT = 4;
    uint256 private constant OFFSET_AMOUNT = 36;
    uint256 private constant _LEN = 68;

    function encode(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(destination, recipient, amount);
    }

    function decode(
        bytes calldata ctx
    )
        internal
        pure
        returns (uint32 destination, bytes32 recipient, uint256 amount)
    {
        require(ctx.length == _LEN);
        destination = uint32(bytes4(ctx[OFFSET_DESTINATION:OFFSET_RECIPIENT]));
        recipient = bytes32(ctx[OFFSET_RECIPIENT:OFFSET_AMOUNT]);
        amount = uint256(bytes32(ctx[OFFSET_AMOUNT:_LEN]));
    }
}

/**
 * @dev Fee quote data layout (packed, 64 bytes):
 *
 * [0:32]   Maximum fee (uint256)
 * [32:64]  Half amount — transfer size at which fee = maxFee/2 (uint256)
 */
library FeeQuoteData {
    uint256 private constant OFFSET_MAX_FEE = 0;
    uint256 private constant OFFSET_HALF_AMOUNT = 32;
    uint256 private constant _LEN = 64;

    function encode(
        uint256 maxFee,
        uint256 halfAmount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(maxFee, halfAmount);
    }

    function decode(
        bytes calldata data
    ) internal pure returns (uint256 maxFee, uint256 halfAmount) {
        require(data.length == _LEN);
        maxFee = uint256(bytes32(data[OFFSET_MAX_FEE:OFFSET_HALF_AMOUNT]));
        halfAmount = uint256(bytes32(data[OFFSET_HALF_AMOUNT:_LEN]));
    }
}

/**
 * @title OffchainQuotedLinearFee
 * @notice ITokenFee implementation backed by offchain-signed quotes with
 *         LinearFee as fallback.
 * @dev Set as `feeRecipient` on a warp route. Resolution cascade:
 *      transient → (destination, recipient) → (destination, *) →
 *      (*, recipient) → immutable LinearFee config.
 *
 *      Quote data: abi.encodePacked(uint256 maxFee, uint256 halfAmount).
 *      Fee = min(maxFee, amount * maxFee / (2 * halfAmount)).
 */
contract OffchainQuotedLinearFee is AbstractOffchainQuoter, LinearFee {
    using TransientStorage for bytes32;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ============ Constants ============

    uint32 constant WILDCARD_DEST = type(uint32).max;
    bytes32 constant WILDCARD_RECIPIENT = bytes32(type(uint256).max);
    uint256 constant WILDCARD_AMOUNT = type(uint256).max;

    bytes32 private constant TRANSIENT_QUOTED_SLOT =
        keccak256("OffchainQuotedLinearFee.quoted");
    bytes32 private constant TRANSIENT_MAX_FEE_SLOT =
        keccak256("OffchainQuotedLinearFee.maxFee");
    bytes32 private constant TRANSIENT_HALF_AMOUNT_SLOT =
        keccak256("OffchainQuotedLinearFee.halfAmount");
    bytes32 private constant TRANSIENT_DESTINATION_SLOT =
        keccak256("OffchainQuotedLinearFee.destination");
    bytes32 private constant TRANSIENT_RECIPIENT_SLOT =
        keccak256("OffchainQuotedLinearFee.recipient");
    bytes32 private constant TRANSIENT_AMOUNT_SLOT =
        keccak256("OffchainQuotedLinearFee.amount");

    // ============ Structs ============

    struct StoredQuote {
        uint256 maxFee;
        uint256 halfAmount;
        uint48 issuedAt;
        uint48 expiry;
    }

    /// @dev A standing quote together with its recipient key, as returned by
    /// `getQuotesForDomain(domainId)` for offchain enumeration within a domain.
    struct QuoteEntry {
        bytes32 recipient;
        StoredQuote quote;
    }

    // ============ Storage ============

    mapping(uint32 destination => mapping(bytes32 recipient => StoredQuote))
        public quotes;

    /// @dev Enumerable key set for `quotes`: the domain ids with at least one
    /// standing quote, and the recipients stored under each. Tracks keys only;
    /// the quote data stays in `quotes`. Entries are never removed (standing
    /// quotes expire logically but are never deleted), so enumeration may
    /// include expired quotes.
    EnumerableSet.UintSet private _domainIds;
    mapping(uint32 domainId => EnumerableSet.Bytes32Set recipients)
        private _recipients;

    // ============ Constructor ============

    constructor(
        address _quoteSigner,
        address _feeToken,
        uint256 _maxFee,
        uint256 _halfAmount,
        address _owner
    ) LinearFee(_feeToken, _maxFee, _halfAmount, _owner) {
        _addQuoteSigner(_quoteSigner);
    }

    function addQuoteSigner(address _signer) external onlyOwner {
        _addQuoteSigner(_signer);
    }

    function removeQuoteSigner(address _signer) external onlyOwner {
        _removeQuoteSigner(_signer);
    }

    // ============ ITokenFee ============

    function feeType() external pure override returns (FeeType) {
        return FeeType.OFFCHAIN_QUOTED_LINEAR;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory) {
        // 1. Transient quote
        if (_matchesTransient(_destination, _recipient, _amount))
            return
                _singleQuote(
                    _computeLinearFee(
                        TRANSIENT_MAX_FEE_SLOT.loadUint256(),
                        TRANSIENT_HALF_AMOUNT_SLOT.loadUint256(),
                        _amount
                    )
                );

        // 2. Specific: destination + recipient
        (bool found, uint256 resolved) = _resolveStored(
            quotes[_destination][_recipient],
            _amount
        );
        if (found) return _singleQuote(resolved);

        // 3. Destination-only
        (found, resolved) = _resolveStored(
            quotes[_destination][WILDCARD_RECIPIENT],
            _amount
        );
        if (found) return _singleQuote(resolved);

        // 4. Recipient-only
        (found, resolved) = _resolveStored(
            quotes[WILDCARD_DEST][_recipient],
            _amount
        );
        if (found) return _singleQuote(resolved);

        // 5. Immutable LinearFee fallback
        return _singleQuote(_computeLinearFee(maxFee, halfAmount, _amount));
    }

    // ============ Internal ============

    // Destination, recipient, and amount each support wildcard (type max).
    function _matchesTransient(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) private view returns (bool) {
        if (!TRANSIENT_QUOTED_SLOT.loadBool()) {
            return false; // no transient quote stored
        }
        uint32 dest = TRANSIENT_DESTINATION_SLOT.loadUint32();
        if (dest != WILDCARD_DEST && dest != _destination) {
            return false; // destination mismatch
        }
        bytes32 recipient = TRANSIENT_RECIPIENT_SLOT.loadBytes32();
        if (recipient != WILDCARD_RECIPIENT && recipient != _recipient) {
            return false; // recipient mismatch
        }
        uint256 amount = TRANSIENT_AMOUNT_SLOT.loadUint256();
        if (amount != WILDCARD_AMOUNT && amount != _amount) {
            return false; // amount mismatch
        }
        return true;
    }

    function _singleQuote(
        uint256 fee
    ) internal view returns (Quote[] memory result) {
        result = new Quote[](1);
        result[0] = Quote(address(token), fee);
    }

    // Decode context and data, write all fields to transient storage for same-tx resolution.
    function _storeTransient(SignedQuote calldata sq) internal override {
        // activate transient flag (distinguishes 0 quotes from empty storage)
        TRANSIENT_QUOTED_SLOT.set();

        // store transferRemote context to match against in this tx
        (uint32 dest, bytes32 recipient, uint256 amount) = FeeQuoteContext
            .decode(sq.context);
        TRANSIENT_DESTINATION_SLOT.store(dest);
        TRANSIENT_RECIPIENT_SLOT.store(recipient);
        TRANSIENT_AMOUNT_SLOT.store(amount);

        // store linear fee params for deriving fees on matching transferRemote in this tx
        (uint256 maxFee_, uint256 halfAmount_) = FeeQuoteData.decode(sq.data);
        TRANSIENT_MAX_FEE_SLOT.store(maxFee_);
        TRANSIENT_HALF_AMOUNT_SLOT.store(halfAmount_);
    }

    function _resolveStored(
        StoredQuote storage sq,
        uint256 amount
    ) internal view returns (bool, uint256) {
        // resolve and derive fee from linear params when standing quote is unexpired
        if (sq.expiry > 0 && uint48(block.timestamp) <= sq.expiry) {
            return (true, _computeLinearFee(sq.maxFee, sq.halfAmount, amount));
        }
        return (false, 0);
    }

    function _storeStanding(
        SignedQuote calldata sq
    ) internal override returns (bool) {
        // amount is signed in the EIP-712 digest but not used as a standing storage key —
        // linear fee params scale with any transfer amount. Require wildcard to make this
        // explicit and prevent signers from accidentally committing to a specific amount.
        (uint32 dest, bytes32 recipient, uint256 amount) = FeeQuoteContext
            .decode(sq.context);
        require(
            amount == WILDCARD_AMOUNT,
            "standing quote amount must be wildcard"
        );

        StoredQuote storage existing = quotes[dest][recipient];

        if (sq.issuedAt < existing.issuedAt) revert StaleQuote();
        if (sq.issuedAt == existing.issuedAt) return false;

        (uint256 maxFee_, uint256 halfAmount_) = FeeQuoteData.decode(sq.data);
        quotes[dest][recipient] = StoredQuote(
            maxFee_,
            halfAmount_,
            sq.issuedAt,
            sq.expiry
        );
        // Track the key for offchain enumeration (idempotent on overwrite).
        _domainIds.add(dest);
        _recipients[dest].add(recipient);
        return true;
    }

    /// @notice Returns the domain ids that have at least one standing quote, for
    /// use with `getQuotesForDomain`. Includes `WILDCARD_DEST` when recipient-only quotes
    /// exist. Unbounded and never pruned; order is unspecified.
    function quoteDomains() external view returns (uint32[] memory domainIds) {
        uint256 len = _domainIds.length();
        domainIds = new uint32[](len);
        for (uint256 i = 0; i < len; i++) {
            domainIds[i] = uint32(_domainIds.at(i));
        }
    }

    /// @notice Returns every standing quote stored under the exact `domainId`
    /// key, each with its recipient key, for offchain enumeration of the raw
    /// `quotes` mapping. Use `quoteDomains()` to discover domain ids.
    /// @dev Returns raw exact-key storage, NOT the effective quotes for a
    /// destination: recipient-only quotes live under the `WILDCARD_DEST`
    /// (`type(uint32).max`) key and apply to every destination, so also query
    /// `getQuotesForDomain(WILDCARD_DEST)` when computing effective fees. Likewise
    /// includes the wildcard recipient and logically-expired entries (never
    /// removed) — filter by `quote.expiry`. Returned order is unspecified and is
    /// not resolution priority. Unbounded: a domain with many signed quotes may
    /// exceed RPC gas/return limits.
    function getQuotesForDomain(
        uint32 domainId
    ) external view returns (QuoteEntry[] memory entries) {
        EnumerableSet.Bytes32Set storage recipients = _recipients[domainId];
        uint256 recipientLen = recipients.length();
        entries = new QuoteEntry[](recipientLen);
        for (uint256 i = 0; i < recipientLen; i++) {
            bytes32 recipient = recipients.at(i);
            entries[i] = QuoteEntry({
                recipient: recipient,
                quote: quotes[domainId][recipient]
            });
        }
    }
}
