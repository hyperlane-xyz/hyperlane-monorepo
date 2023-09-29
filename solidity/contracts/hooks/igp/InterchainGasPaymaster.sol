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

// ============ Internal Imports ============
import {Message} from "../../libs/Message.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";
import {IGasOracle} from "../../interfaces/IGasOracle.sol";
import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {Indexed} from "../../libs/Indexed.sol";

// ============ External Imports ============
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title InterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of relaying
 * messages to destination chains and includes the gas overhead per destination
 * @dev The intended use of this contract is to store overhead gas amounts for destination
 * domains, e.g. Mailbox and/or ISM gas usage, such that users of this IGP are only required
 * to specify the gas amount used by their own applications.
 */
contract InterchainGasPaymaster is
    IInterchainGasPaymaster,
    AbstractPostDispatchHook,
    IGasOracle,
    Indexed,
    OwnableUpgradeable
{
    using Address for address payable;
    using Message for bytes;
    using StandardHookMetadata for bytes;
    // ============ Constants ============

    /// @notice The scale of gas oracle token exchange rates.
    uint256 internal constant TOKEN_EXCHANGE_RATE_SCALE = 1e10;
    /// @notice default for user call if metadata not provided
    uint256 internal immutable DEFAULT_GAS_USAGE = 69_420;

    // ============ Public Storage ============

    /// @notice Keyed by remote domain, the gas oracle to use for the domain.
    mapping(uint32 => IGasOracle) public gasOracles;

    /// @notice Destination domain => overhead gas amount on that domain.
    mapping(uint32 => uint256) public destinationGasOverhead;

    /// @notice The benficiary that can receive native tokens paid into this contract.
    address public beneficiary;

    // ============ Events ============

    /**
     * @notice Emitted when the gas oracle for a remote domain is set.
     * @param remoteDomain The remote domain.
     * @param gasOracle The gas oracle.
     */
    event GasOracleSet(uint32 indexed remoteDomain, address gasOracle);

    /**
     * @notice Emitted when the beneficiary is set.
     * @param beneficiary The new beneficiary.
     */
    event BeneficiarySet(address beneficiary);

    struct GasOracleConfig {
        uint32 remoteDomain;
        address gasOracle;
    }

    struct DomainConfig {
        uint32 domain;
        uint256 gasOverhead;
    }

    /**
     * @notice Emitted when an entry in the destinationGasOverhead mapping is set.
     * @param domain The destination domain.
     * @param gasOverhead The gas overhead amount on that domain.
     */
    event DestinationGasOverheadSet(uint32 indexed domain, uint256 gasOverhead);

    // ============ External Functions ============

    /**
     * @param _owner The owner of the contract.
     * @param _beneficiary The beneficiary.
     */
    function initialize(address _owner, address _beneficiary)
        public
        initializer
    {
        __Ownable_init();
        _transferOwnership(_owner);
        _setBeneficiary(_beneficiary);
    }

    /**
     * @notice Transfers the entire native token balance to the beneficiary.
     * @dev The beneficiary must be able to receive native tokens.
     */
    function claim() external {
        // Transfer the entire balance to the beneficiary.
        (bool success, ) = beneficiary.call{value: address(this).balance}("");
        require(success, "!transfer");
    }

    /**
     * @notice Sets the gas oracles for remote domains specified in the config array.
     * @param _configs An array of configs including the remote domain and gas oracles to set.
     */
    function setGasOracles(GasOracleConfig[] calldata _configs)
        external
        onlyOwner
    {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            _setGasOracle(_configs[i].remoteDomain, _configs[i].gasOracle);
        }
    }

    /**
     * @notice Sets the beneficiary.
     * @param _beneficiary The new beneficiary.
     */
    function setBeneficiary(address _beneficiary) external onlyOwner {
        _setBeneficiary(_beneficiary);
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
     * @notice Deposits msg.value as a payment for the relaying of a message
     * to its destination chain.
     * @dev Overpayment will result in a refund of native tokens to the _refundAddress.
     * Callers should be aware that this may present reentrancy issues.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasAmount The amount of destination gas to pay for.
     * @param _refundAddress The address to refund any overpayment to.
     */
    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasAmount,
        address _refundAddress
    ) public payable override {
        uint256 _requiredGasAmount = destinationGasAmount(
            _destinationDomain,
            _gasAmount
        );
        uint256 _requiredPayment = quoteGasPayment(
            _destinationDomain,
            _requiredGasAmount
        );
        require(
            msg.value >= _requiredPayment,
            "insufficient interchain gas payment"
        );
        uint256 _overpayment = msg.value - _requiredPayment;
        if (_overpayment > 0) {
            require(_refundAddress != address(0), "no refund address");
            payable(_refundAddress).sendValue(_overpayment);
        }

        emit GasPayment(
            _messageId,
            _destinationDomain,
            _requiredGasAmount,
            _requiredPayment
        );
    }

    /**
     * @notice Quotes the amount of native tokens to pay for interchain gas.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _totalGasAmount The amount of destination gas to pay for.
     * @return The amount of native tokens required to pay for interchain gas.
     */
    function quoteGasPayment(uint32 _destinationDomain, uint256 _totalGasAmount)
        public
        view
        virtual
        override
        returns (uint256)
    {
        // Get the gas data for the destination domain.
        (
            uint128 _tokenExchangeRate,
            uint128 _gasPrice
        ) = getExchangeRateAndGasPrice(_destinationDomain);

        // The total cost quoted in destination chain's native token.
        uint256 _destinationGasCost = _totalGasAmount * uint256(_gasPrice);

        // Convert to the local native token.
        return
            (_destinationGasCost * _tokenExchangeRate) /
            TOKEN_EXCHANGE_RATE_SCALE;
    }

    /**
     * @notice Gets the token exchange rate and gas price from the configured gas oracle
     * for a given destination domain.
     * @param _destinationDomain The destination domain.
     * @return tokenExchangeRate The exchange rate of the remote native token quoted in the local native token.
     * @return gasPrice The gas price on the remote chain.
     */
    function getExchangeRateAndGasPrice(uint32 _destinationDomain)
        public
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        IGasOracle _gasOracle = gasOracles[_destinationDomain];

        require(
            address(_gasOracle) != address(0),
            string.concat(
                "Configured IGP doesn't support domain ",
                Strings.toString(_destinationDomain)
            )
        );

        return _gasOracle.getExchangeRateAndGasPrice(_destinationDomain);
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

    // ============ Internal Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        uint256 gasLimit = metadata.gasLimit(DEFAULT_GAS_USAGE);
        address refundAddress = metadata.refundAddress(message.senderAddress());
        payForGas(message.id(), message.destination(), gasLimit, refundAddress);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(bytes calldata metadata, bytes calldata message)
        internal
        view
        override
        returns (uint256)
    {
        uint256 gasLimit = metadata.gasLimit(DEFAULT_GAS_USAGE);
        return quoteGasPayment(message.destination(), gasLimit);
    }

    /**
     * @notice Sets the beneficiary.
     * @param _beneficiary The new beneficiary.
     */
    function _setBeneficiary(address _beneficiary) internal {
        beneficiary = _beneficiary;
        emit BeneficiarySet(_beneficiary);
    }

    /**
     * @notice Sets the gas oracle for a remote domain.
     * @param _remoteDomain The remote domain.
     * @param _gasOracle The gas oracle.
     */
    function _setGasOracle(uint32 _remoteDomain, address _gasOracle) internal {
        gasOracles[_remoteDomain] = IGasOracle(_gasOracle);
        emit GasOracleSet(_remoteDomain, _gasOracle);
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
