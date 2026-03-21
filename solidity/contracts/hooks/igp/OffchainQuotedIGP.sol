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

/**
 * @dev IGP quote context layout (packed, 44 bytes):
 *
 * [0:20]   Fee token address (address)
 * [20:24]  Destination domain (uint32)
 * [24:44]  Sender address (address)
 */
library IGPQuoteContext {
    uint256 private constant OFFSET_FEE_TOKEN = 0;
    uint256 private constant OFFSET_DESTINATION = 20;
    uint256 private constant OFFSET_SENDER = 24;
    uint256 private constant _LEN = 44;

    function encode(
        address feeToken,
        uint32 destination,
        address sender
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(feeToken, destination, sender);
    }

    function decode(
        bytes calldata ctx
    )
        internal
        pure
        returns (address feeToken, uint32 destination, address sender)
    {
        require(ctx.length == _LEN);
        feeToken = address(bytes20(ctx[OFFSET_FEE_TOKEN:OFFSET_DESTINATION]));
        destination = uint32(bytes4(ctx[OFFSET_DESTINATION:OFFSET_SENDER]));
        sender = address(bytes20(ctx[OFFSET_SENDER:_LEN]));
    }
}

/**
 * @dev IGP quote data layout (packed, 32 bytes):
 *
 * [0:16]   Token exchange rate (uint128)
 * [16:32]  Gas price (uint128)
 */
library IGPQuoteData {
    uint256 private constant OFFSET_EXCHANGE_RATE = 0;
    uint256 private constant OFFSET_GAS_PRICE = 16;
    uint256 private constant _LEN = 32;

    function encode(
        uint128 exchangeRate,
        uint128 gasPrice
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(exchangeRate, gasPrice);
    }

    function decode(
        bytes calldata data
    ) internal pure returns (uint128 exchangeRate, uint128 gasPrice) {
        require(data.length == _LEN);
        exchangeRate = uint128(
            bytes16(data[OFFSET_EXCHANGE_RATE:OFFSET_GAS_PRICE])
        );
        gasPrice = uint128(bytes16(data[OFFSET_GAS_PRICE:_LEN]));
    }
}

/**
 * @title OffchainQuotedIGP
 * @notice Offchain-signed gas quote resolution for the IGP.
 * @dev Provides transient and standing quote storage, resolution cascade,
 *      and signer management. Inherits AbstractOffchainQuoter for EIP-712 verification.
 */
abstract contract OffchainQuotedIGP is AbstractOffchainQuoter {
    using TransientStorage for bytes32;

    // ============ Constants ============

    uint32 constant WILDCARD_DEST = type(uint32).max;
    address constant WILDCARD_SENDER = address(type(uint160).max);

    // ============ Structs ============

    struct StoredGasQuote {
        uint128 tokenExchangeRate;
        uint128 gasPrice;
        uint48 issuedAt;
        uint48 expiry;
    }

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:hyperlane.storage.OffchainQuotedIGP
    struct OffchainQuotedIGPStorage {
        /// @notice Standing offchain quotes
        mapping(address feeToken => mapping(uint32 destination => mapping(address sender => StoredGasQuote))) offchainQuotes;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("hyperlane.storage.OffchainQuotedIGP")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OFFCHAIN_QUOTED_IGP_STORAGE_LOCATION =
        0x37f6b30297338df08e6d85e9801872705361ae192b2a17f9ad37df1c08991200;

    function _getOffchainQuotedIGPStorage()
        private
        pure
        returns (OffchainQuotedIGPStorage storage $)
    {
        assembly {
            $.slot := OFFCHAIN_QUOTED_IGP_STORAGE_LOCATION
        }
    }

    /// @notice Read a standing offchain quote.
    function offchainQuotes(
        address feeToken,
        uint32 destination,
        address sender
    ) external view returns (StoredGasQuote memory) {
        return
            _getOffchainQuotedIGPStorage().offchainQuotes[feeToken][
                destination
            ][sender];
    }

    // ============ Transient Storage Slots ============

    bytes32 private constant TRANSIENT_QUOTED_SLOT =
        keccak256("OffchainQuotedIGP.quoted");
    bytes32 private constant TRANSIENT_EXCHANGE_RATE_SLOT =
        keccak256("OffchainQuotedIGP.exchangeRate");
    bytes32 private constant TRANSIENT_GAS_PRICE_SLOT =
        keccak256("OffchainQuotedIGP.gasPrice");
    bytes32 private constant TRANSIENT_FEE_TOKEN_SLOT =
        keccak256("OffchainQuotedIGP.feeToken");
    bytes32 private constant TRANSIENT_DESTINATION_SLOT =
        keccak256("OffchainQuotedIGP.destination");
    bytes32 private constant TRANSIENT_SENDER_SLOT =
        keccak256("OffchainQuotedIGP.sender");

    // ============ Quote Resolution ============

    /**
     * @notice Try to resolve exchange rate and gas price from offchain quotes.
     * @return found Whether an offchain quote was found.
     * @return exchangeRate The token exchange rate (if found).
     * @return gasPrice The gas price (if found).
     */
    function _resolveOffchainQuote(
        address _feeToken,
        uint32 _destinationDomain,
        address _sender
    )
        internal
        view
        returns (bool found, uint128 exchangeRate, uint128 gasPrice)
    {
        // 1. Transient offchain quote
        if (_matchesTransient(_feeToken, _destinationDomain, _sender))
            return (
                true,
                TRANSIENT_EXCHANGE_RATE_SLOT.loadUint128(),
                TRANSIENT_GAS_PRICE_SLOT.loadUint128()
            );

        OffchainQuotedIGPStorage storage $ = _getOffchainQuotedIGPStorage();

        // 2. Specific: feeToken + destination + sender
        StoredGasQuote storage sq = $.offchainQuotes[_feeToken][
            _destinationDomain
        ][_sender];
        if (_isActive(sq)) return (true, sq.tokenExchangeRate, sq.gasPrice);

        // 3. Destination-only
        sq = $.offchainQuotes[_feeToken][_destinationDomain][WILDCARD_SENDER];
        if (_isActive(sq)) return (true, sq.tokenExchangeRate, sq.gasPrice);

        // 4. Sender-only
        sq = $.offchainQuotes[_feeToken][WILDCARD_DEST][_sender];
        if (_isActive(sq)) return (true, sq.tokenExchangeRate, sq.gasPrice);
    }

    // Fee token must match exactly; destination and sender support wildcard (type max).
    function _matchesTransient(
        address _feeToken,
        uint32 _destinationDomain,
        address _sender
    ) private view returns (bool) {
        if (!TRANSIENT_QUOTED_SLOT.loadBool()) {
            return false; // no transient quote stored
        }
        if (TRANSIENT_FEE_TOKEN_SLOT.loadAddress() != _feeToken) {
            return false; // fee token must match exactly
        }
        uint32 dest = TRANSIENT_DESTINATION_SLOT.loadUint32();
        if (dest != WILDCARD_DEST && dest != _destinationDomain) {
            return false; // destination mismatch
        }
        address sender = TRANSIENT_SENDER_SLOT.loadAddress();
        if (sender != WILDCARD_SENDER && sender != _sender) {
            return false; // sender mismatch
        }
        return true;
    }

    function _isActive(StoredGasQuote storage sq) internal view returns (bool) {
        return sq.expiry > 0 && uint48(block.timestamp) <= sq.expiry;
    }

    // ============ AbstractOffchainQuoter Implementation ============

    // Decode context and data, write all fields to transient storage for same-tx resolution.
    function _storeTransient(SignedQuote calldata sq) internal override {
        TRANSIENT_QUOTED_SLOT.set();
        (uint128 rate, uint128 gasPrice) = IGPQuoteData.decode(sq.data);
        TRANSIENT_EXCHANGE_RATE_SLOT.store(rate);
        TRANSIENT_GAS_PRICE_SLOT.store(gasPrice);
        (address feeToken_, uint32 dest, address sender) = IGPQuoteContext
            .decode(sq.context);
        TRANSIENT_FEE_TOKEN_SLOT.store(feeToken_);
        TRANSIENT_DESTINATION_SLOT.store(dest);
        TRANSIENT_SENDER_SLOT.store(sender);
    }

    // Decode context and data, write to persistent storage. Rejects stale quotes.
    function _storeStanding(SignedQuote calldata sq) internal override {
        (address feeToken_, uint32 dest, address sender) = IGPQuoteContext
            .decode(sq.context);
        OffchainQuotedIGPStorage storage $ = _getOffchainQuotedIGPStorage();
        StoredGasQuote storage existing = $.offchainQuotes[feeToken_][dest][
            sender
        ];
        if (sq.issuedAt <= existing.issuedAt) revert StaleQuote();
        (uint128 rate, uint128 gasPrice) = IGPQuoteData.decode(sq.data);
        $.offchainQuotes[feeToken_][dest][sender] = StoredGasQuote(
            rate,
            gasPrice,
            sq.issuedAt,
            sq.expiry
        );
    }
}
