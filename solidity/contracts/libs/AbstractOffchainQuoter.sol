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

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {SignedQuote, IOffchainQuoter} from "../interfaces/IOffchainQuoter.sol";

/**
 * @title AbstractOffchainQuoter
 * @notice Mixin for offchain-signed fee quotes with EIP-712 verification.
 * @dev Uses ERC-7201 namespaced storage for the signer set to avoid
 *      storage layout conflicts in upgradeable contracts.
 *      Concrete contracts define their own stored quote types and transient variables.
 */
abstract contract AbstractOffchainQuoter is IOffchainQuoter {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ============ Constants ============

    bytes32 public constant SIGNED_QUOTE_TYPEHASH =
        keccak256(
            "SignedQuote(bytes context,bytes data,uint48 issuedAt,uint48 expiry,bytes32 salt,address submitter)"
        );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    bytes32 private constant _NAME_HASH = keccak256("OffchainQuoter");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    // ============ ERC-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:hyperlane.storage.AbstractOffchainQuoter
    struct QuoterStorage {
        EnumerableSet.AddressSet signers;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("hyperlane.storage.AbstractOffchainQuoter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant QUOTER_STORAGE_SLOT =
        0x64f71a44403ec21f823dd9edb7275f10db1dce468c4e448159a561ce20e08a00;

    function _getQuoterStorage()
        private
        pure
        returns (QuoterStorage storage $)
    {
        assembly {
            $.slot := QUOTER_STORAGE_SLOT
        }
    }

    // ============ Errors ============

    error QuoteExpired();
    error StaleQuote();
    error InvalidSigner();
    error InvalidSubmitter();

    // ============ Events ============

    event QuoteSubmitted(bytes context, uint48 issuedAt, uint48 expiry);

    event QuoteSignerAdded(address signer);
    event QuoteSignerRemoved(address signer);

    // ============ External ============

    function submitQuote(
        SignedQuote calldata sq,
        bytes calldata signature
    ) external {
        if (uint48(block.timestamp) > sq.expiry) revert QuoteExpired();
        // submitter field restricts who can submit (e.g. QuotedCalls only).
        // address(0) means unrestricted — any caller may submit.
        if (sq.submitter != address(0) && msg.sender != sq.submitter) {
            revert InvalidSubmitter();
        }
        _verifyQuoteSigner(sq, signature);

        // transient quotes (expiry == issuedAt) auto-clear at end of tx.
        // standing quotes persist in storage until they expire or are overwritten.
        if (sq.expiry == sq.issuedAt) {
            _storeTransient(sq);
        } else {
            bool updated = _storeStanding(sq);
            if (updated) {
                emit QuoteSubmitted(sq.context, sq.issuedAt, sq.expiry);
            }
        }
    }

    // ============ Views ============

    function quoteSigners() external view returns (address[] memory) {
        return _getQuoterStorage().signers.values();
    }

    function isQuoteSigner(address _signer) public view returns (bool) {
        return _getQuoterStorage().signers.contains(_signer);
    }

    // ============ Internal ============

    function _addQuoteSigner(address _signer) internal {
        if (_getQuoterStorage().signers.add(_signer)) {
            emit QuoteSignerAdded(_signer);
        }
    }

    /// @dev Removing a signer does NOT invalidate standing quotes already in
    ///      storage. Unexpired standing quotes from a removed signer remain
    ///      resolvable until they expire or are overwritten.
    function _removeQuoteSigner(address _signer) internal {
        if (_getQuoterStorage().signers.remove(_signer)) {
            emit QuoteSignerRemoved(_signer);
        }
    }

    // ============ Internal: EIP-712 ============

    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _NAME_HASH,
                    _VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    function _verifyQuoteSigner(
        SignedQuote calldata sq,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SIGNED_QUOTE_TYPEHASH,
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(_domainSeparator(), structHash);
        address signer = ECDSA.recover(digest, signature);
        if (!isQuoteSigner(signer)) revert InvalidSigner();
    }

    // ============ Abstract ============

    function _storeTransient(SignedQuote calldata sq) internal virtual;
    function _storeStanding(SignedQuote calldata sq) internal virtual returns (bool updated);
}
