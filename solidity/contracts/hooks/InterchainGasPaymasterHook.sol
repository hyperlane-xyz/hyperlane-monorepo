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
import {Message} from "../libs/Message.sol";
import {IGasOracle} from "../interfaces/IGasOracle.sol";
import {IGPHookMetadata} from "../libs/hooks/IGPHookMetadata.sol";
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymasterV3.sol";
import {AbstractHook} from "./AbstractHook.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract InterchainGasPaymasterHook is
    IInterchainGasPaymaster,
    AbstractHook,
    OwnableUpgradeable
{
    using Address for address;
    using IGPHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    /// @notice The scale of gas oracle token exchange rates.
    uint256 internal constant DECIMALS = 1e10;
    /// @notice default for user call if metadata not provided
    uint256 internal constant DEFAULT_GAS_USAGE = 69_420;

    // ============ Public Storage ============

    /// @notice Keyed by remote domain, the gas oracle to use for the domain.
    address public gasOracle;
    /// @notice The benficiary that can receive native tokens paid into this contract.
    address public beneficiary;

    // ============ Events ============

    /**
     * @notice Emitted when the gas oracle is set.
     * @param gasOracle The new beneficiary.
     */
    event GasOracleSet(address indexed gasOracle);

    /**
     * @notice Emitted when the beneficiary is set.
     * @param beneficiary The new beneficiary.
     */
    event BeneficiarySet(address indexed beneficiary);

    // ============ Constructor ============

    constructor(address _mailbox) AbstractHook(_mailbox) {}

    // ============ External functions ============

    /**
     * @param _owner The owner of the contract.
     * @param _beneficiary The beneficiary.
     * @param _gasOracle The gas oracle.
     */
    function initialize(
        address _owner,
        address _beneficiary,
        address _gasOracle
    ) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
        _setBeneficiary(_beneficiary);
        _setGasOracle(_gasOracle);
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
     * @notice Updates the gas oracle
     * @param _gasOracle address of the new gas oracle
     */
    function setGasOracles(address _gasOracle) external onlyOwner {
        _setGasOracle(_gasOracle);
    }

    /**
     * @notice Sets the beneficiary.
     * @param _beneficiary The new beneficiary.
     */
    function setBeneficiary(address _beneficiary) external onlyOwner {
        _setBeneficiary(_beneficiary);
    }

    // ============ Public Functions ============

    /**
     * @notice Deposits msg.value as a payment for the relaying of a message
     * to its destination chain.
     * @dev Overpayment will result in a refund of native tokens to the _refundAddress.
     * Callers should be aware that this may present reentrancy issues.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @param _refundAddress The address to refund any overpayment to.
     */
    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasLimit,
        address _refundAddress
    ) public payable override {
        uint256 _requiredPayment = quoteGasPayment(
            _destinationDomain,
            _gasLimit
        );
        require(
            msg.value >= _requiredPayment,
            "IGPHook: insufficient gas payment"
        );
        uint256 _overpayment = msg.value - _requiredPayment;
        if (_overpayment > 0) {
            (bool _success, ) = _refundAddress.call{value: _overpayment}("");
            require(_success, "IGPHook: refund failed");
        }

        emit GasPayment(_messageId, _gasLimit, _requiredPayment);
    }

    /**
     * @notice Quotes the amount of native tokens to pay for interchain gas.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @return The amount of native tokens required to pay for interchain gas.
     */
    function quoteGasPayment(uint32 _destinationDomain, uint256 _gasLimit)
        public
        view
        virtual
        override
        returns (uint256)
    {
        // Get the gas data for the destination domain.
        require(gasOracle.isContract(), "IGPHook: invalid gas oracle");
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = IGasOracle(gasOracle)
            .getExchangeRateAndGasPrice(_destinationDomain);

        // The total cost quoted in destination chain's native token.
        uint256 _destinationGasCost = _gasLimit * uint256(_gasPrice);

        // Convert to the local native token.
        return (_destinationGasCost * _tokenExchangeRate) / DECIMALS;
    }

    // ============ Internal Functions ============

    function _postDispatch(bytes calldata _metadata, bytes calldata _message)
        internal
        override
    {
        if (_metadata.length == 0) {
            payForGas(
                _message.id(),
                _message.destination(),
                DEFAULT_GAS_USAGE,
                _message.senderAddress()
            );
        } else {
            address refundAddress = _metadata.refundAddress();
            if (refundAddress != address(0))
                refundAddress = _message.senderAddress();
            payForGas(
                _message.id(),
                _message.destination(),
                _metadata.gasLimit(),
                refundAddress
            );
        }
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
     * @notice Sets the storage oracle.
     * @param _gasOracle The new storage oracle.
     */
    function _setGasOracle(address _gasOracle) internal {
        gasOracle = _gasOracle;
        emit GasOracleSet(_gasOracle);
    }
}
