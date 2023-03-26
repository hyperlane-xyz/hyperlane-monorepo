// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
import {InterchainGasPaymaster} from "./InterchainGasPaymaster.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice An IGP that adds configured gas overheads to gas amounts and forwards
 * calls to an "inner" IGP.
 * @dev The intended use of this contract is to store overhead gas amounts for destination
 * domains, e.g. Mailbox and/or ISM gas usage, such that users of this IGP are only required
 * to specify the gas amount used by their own applications.
 */
contract FallbackIgp is IInterchainGasPaymaster, Ownable {
    // ============ Constants ============

    /// @notice The overhead IGP that's called.
    IInterchainGasPaymaster public immutable overheadIgp;

    /// @notice The fee quoting IGP, i.e. the inner IGP of the overhead IGP.
    InterchainGasPaymaster public immutable feeQuotingIgp;

    uint256 public constant FALLBACK_PAYMENT = 1;

    // ============ Constructor ============

    constructor(address _overheadIgp, address _feeQuotingIgp) {
        overheadIgp = IInterchainGasPaymaster(_overheadIgp);
        feeQuotingIgp = InterchainGasPaymaster(_feeQuotingIgp);
    }

    // ============ External Functions ============

    /**
     * @notice Adds the stored destinationGasOverhead to the _gasAmount and forwards the
     * call to the innerIgp's `payForGas` function.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasAmount The amount of destination gas to pay for. This should not
     * consider any gas that is accounted for in the stored destinationGasOverhead.
     * @param _refundAddress The address to refund any overpayment to.
     */
    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) external payable {
        if (isFeeQuotedDestination(_destinationDomain)) {
            overheadIgp.payForGas{value: msg.value}(
                _messageId,
                _destinationDomain,
                _gasAmount,
                _refundAddress
            );
            return;
        }
        require(msg.value >= FALLBACK_PAYMENT, "insufficient fallback payment");
        emit GasPayment(_messageId, _gasAmount, msg.value);
    }

    // ============ Public Functions ============

    function quoteGasPayment(uint32 _destinationDomain, uint256 _gasAmount)
        public
        view
        returns (uint256)
    {
        if (isFeeQuotedDestination(_destinationDomain)) {
            return overheadIgp.quoteGasPayment(_destinationDomain, _gasAmount);
        }
        return FALLBACK_PAYMENT;
    }

    /**
     * @notice Transfers the entire native token balance to the beneficiary.
     * @dev The beneficiary must be able to receive native tokens.
     */
    function claim() external {
        // Transfer the entire balance to the beneficiary.
        (bool success, ) = feeQuotingIgp.beneficiary().call{
            value: address(this).balance
        }("");
        require(success, "!transfer");
    }

    function isFeeQuotedDestination(uint32 _destinationDomain)
        public
        view
        returns (bool)
    {
        return
            address(feeQuotingIgp.gasOracles(_destinationDomain)) != address(0);
    }
}
