// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @notice An IGP that adds configured gas overheads to gas amounts and forwards
 * calls to an "inner" IGP.
 * @dev The intended use of this contract is to store overhead gas amounts for destination
 * domains, e.g. Mailbox and/or ISM gas usage, such that users of this IGP are only required
 * to specify the gas amount used by their own applications.
 */
contract OverheadIgp is IInterchainGasPaymaster, Ownable {
    // ============ Constants ============

    /// @notice The IGP that is called when paying for or quoting gas
    /// after applying overhead gas amounts.
    IInterchainGasPaymaster public immutable innerIgp;

    // ============ Public Storage ============

    /// @notice Destination domain => overhead gas amount on that domain.
    mapping(uint32 => uint256) public destinationGasOverhead;

    // ============ Events ============

    /**
     * @notice Emitted when an entry in the destinationGasOverhead mapping is set.
     * @param domain The destination domain.
     * @param gasOverhead The gas overhead amount on that domain.
     */
    event DestinationGasOverheadSet(uint32 indexed domain, uint256 gasOverhead);

    struct DomainConfig {
        uint32 domain;
        uint256 gasOverhead;
    }

    // ============ Constructor ============

    constructor(address _innerIgp) {
        innerIgp = IInterchainGasPaymaster(_innerIgp);
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
        innerIgp.payForGas{value: msg.value}(
            _messageId,
            _destinationDomain,
            destinationGasAmount(_destinationDomain, _gasAmount),
            _refundAddress
        );
    }

    /**
     * @notice Sets destination gas overheads for multiple domains.
     * @dev Only callable by the owner.
     * @param configs A list of destination domains and gas overheads.
     */
    function setDestinationGasOverheads(DomainConfig[] calldata configs)
        external
        onlyOwner
    {
        for (uint256 i; i < configs.length; i++) {
            _setDestinationGasOverhead(configs[i]);
        }
    }

    // ============ Public Functions ============

    /**
     * @notice Adds the stored destinationGasOverhead to the _gasAmount and forwards the
     * call to the innerIgp's `quoteGasPayment` function.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasAmount The amount of destination gas to pay for. This should not
     * consider any gas that is accounted for in the stored destinationGasOverhead.
     * @return The amount of native tokens required to pay for interchain gas.
     */
    function quoteGasPayment(uint32 _destinationDomain, uint256 _gasAmount)
        public
        view
        returns (uint256)
    {
        return
            innerIgp.quoteGasPayment(
                _destinationDomain,
                destinationGasAmount(_destinationDomain, _gasAmount)
            );
    }

    /**
     * @notice Returns the stored destinationGasOverhead added to the _gasAmount.
     * @dev If there is no stored destinationGasOverhead, 0 is used.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasAmount The amount of destination gas to pay for. This should not
     * consider any gas that is accounted for in the stored destinationGasOverhead.
     * @return The stored destinationGasOverhead added to the _gasAmount.
     */
    function destinationGasAmount(uint32 _destinationDomain, uint256 _gasAmount)
        public
        view
        returns (uint256)
    {
        return destinationGasOverhead[_destinationDomain] + _gasAmount;
    }

    /**
     * @notice Sets the destination gas overhead for a single domain.
     * @param config The destination domain and gas overhead.
     */
    function _setDestinationGasOverhead(DomainConfig calldata config) internal {
        destinationGasOverhead[config.domain] = config.gasOverhead;
        emit DestinationGasOverheadSet(config.domain, config.gasOverhead);
    }
}
