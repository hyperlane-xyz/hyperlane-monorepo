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

struct SignedQuote {
    /// @dev Opaque context identifying what is being quoted (e.g. destination,
    ///      recipient, amount). Decoded by the concrete quoter.
    bytes context;
    /// @dev Opaque quote data (e.g. fee parameters, exchange rates).
    ///      Decoded by the concrete quoter.
    bytes data;
    /// @dev Timestamp when the quote was issued. Signed to enforce update
    ///      policy — prevents replay of old quotes with a manipulated
    ///      timestamp to overwrite fresher standing quotes.
    uint48 issuedAt;
    /// @dev Expiry timestamp. If == issuedAt, the quote is transient
    ///      (auto-clears at end of transaction via transient storage).
    uint48 expiry;
    /// @dev Caller-binding salt, typically bytes32(uint256(uint160(caller))).
    ///      Verified by QuotedCalls to bind quotes to the transaction sender.
    bytes32 salt;
    /// @dev Authorized submitter address. If address(0), any address may
    ///      submit. Used to restrict submission to specific contracts
    ///      (e.g. QuotedCalls).
    address submitter;
}

interface IOffchainQuoter {
    function submitQuote(
        SignedQuote calldata sq,
        bytes calldata signature
    ) external;
}
