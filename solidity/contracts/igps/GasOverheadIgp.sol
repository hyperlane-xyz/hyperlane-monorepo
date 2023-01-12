// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @notice An IGP that adds configured gas overheads to gas amounts and forwards
 * calls to an "inner" IGP.
 * @dev The intended use of this contract is to store overhead gas amounts for destination
 * domains, e.g. Mailbox and/or ISM gas usage, such that users of this IGP are only required
 * to specify the gas amount used by their own applications.
 */
contract GasOverheadIgp is IInterchainGasPaymaster, OwnableUpgradeable {
    /// @notice The IGP that is called when paying for or quoting gas
    /// after applying overhead gas amounts.
    IInterchainGasPaymaster public innerIgp;

    /// @notice Destination domain => overhead gas amount on that domain.
    mapping(uint32 => uint256) public destinationGasOverhead;

    /**
     * @notice Emitted when the innerIgp is set.
     * @param innerIgp The new innerIgp.
     */
    event InnerIgpSet(address innerIgp);

    /**
     * @notice Emitted when an entry in the destinationGasOverhead mapping is set.
     * @param domain The destination domain.
     * @param gasOverhead The gas overhead amount on that domain.
     */
    event DestinationGasOverheadSet(uint32 indexed domain, uint256 gasOverhead);

    // ============ Constructor ============

    constructor(address _innerIgp) {
        initialize(_innerIgp); // allows contract to be used without proxying
    }

    // ============ External Functions ============

    /**
     * @notice Initializes the contract.
     * @param _innerIgp The innerIgp.
     */
    function initialize(address _innerIgp) public initializer {
        __Ownable_init();

        _setInnerIgp(_innerIgp);
    }

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
     * @notice Sets destination gas overheads for multiple domains.
     * @dev Only callable by the owner.
     * @dev _domains.length and _gasOverheads.length must be the same.
     * @param _domains The destination domains to set gas overheads for.
     * @param _gasOverheads The gas overheads for each corresponding domain in _domains.
     */
    function setDestinationGasOverheads(
        uint32[] calldata _domains,
        uint256[] calldata _gasOverheads
    ) external onlyOwner {
        require(
            _domains.length == _gasOverheads.length,
            "Domain and gas overhead length mismatch"
        );

        for (uint256 i; i < _domains.length; i++) {
            _setDestinationGasOverhead(_domains[i], _gasOverheads[i]);
        }
    }

    /**
     * @notice Sets the innerIgp.
     * @dev Only callable by the owner.
     * @param _innerIgp The new innerIgp.
     */
    function setInnerIgp(address _innerIgp) external onlyOwner {
        _setInnerIgp(_innerIgp);
    }

    /**
     * @notice Sets the innerIgp.
     * @param _innerIgp The new innerIgp.
     */
    function _setInnerIgp(address _innerIgp) internal {
        innerIgp = IInterchainGasPaymaster(_innerIgp);
        emit InnerIgpSet(_innerIgp);
    }

    /**
     * @notice Sets the destination gas overhead for a single domain.
     * @param _domain The destination domain.
     * @param _gasOverhead The gas overhead for the domain.
     */
    function _setDestinationGasOverhead(uint32 _domain, uint256 _gasOverhead)
        internal
    {
        destinationGasOverhead[_domain] = _gasOverhead;
        emit DestinationGasOverheadSet(_domain, _gasOverhead);
    }
}
