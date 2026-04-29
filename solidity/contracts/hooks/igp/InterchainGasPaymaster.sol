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

import {MinimalInterchainGasPaymaster} from "./MinimalInterchainGasPaymaster.sol";
import {OffchainQuotedIGP} from "./OffchainQuotedIGP.sol";

/**
 * @title InterchainGasPaymaster
 * @notice The default cancun-deployed IGP: consults EIP-712 signed offchain
 *         gas quotes (transient + standing) before falling through to the
 *         on-chain oracle.
 * @dev Requires Cancun-target compilation (transient storage opcodes via
 *      OffchainQuotedIGP/TransientStorage). On the paris legacy EVM target,
 *      MinimalInterchainGasPaymaster is deployed instead. Storage layout is
 *      bytecode-identical to the pre-split monolithic InterchainGasPaymaster
 *      — all offchain-quote state lives in ERC-7201 namespaced slots — so
 *      existing deployments require no migration.
 */
contract InterchainGasPaymaster is
    MinimalInterchainGasPaymaster,
    OffchainQuotedIGP
{
    /// @inheritdoc MinimalInterchainGasPaymaster
    /// @dev Resolves offchain quotes first, then falls through to oracle.
    function _resolveExchangeRateAndGasPrice(
        address _feeToken,
        uint32 _destinationDomain,
        address _sender
    )
        internal
        view
        virtual
        override
        returns (uint128 exchangeRate, uint128 gasPrice)
    {
        bool found;
        (found, exchangeRate, gasPrice) = _resolveOffchainQuote(
            _feeToken,
            _destinationDomain,
            _sender
        );
        if (found) return (exchangeRate, gasPrice);
        return _getExchangeRateAndGasPrice(_feeToken, _destinationDomain);
    }

    function addQuoteSigner(address _signer) external onlyOwner {
        _addQuoteSigner(_signer);
    }

    function removeQuoteSigner(address _signer) external onlyOwner {
        _removeQuoteSigner(_signer);
    }
}
