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
import {EnumerableDomainSet} from "../../libs/EnumerableDomainSet.sol";

// ============ External Imports ============
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title InterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of relaying
 * messages to destination chains and includes the gas overhead per destination
 * @dev The intended use of this contract is to store overhead gas amounts for destination
 * domains, e.g. Mailbox and ISM gas usage, such that users of this IGP are only required
 * to specify the gas amount used by their own applications.
 */
contract InterchainGasPaymaster is
    IInterchainGasPaymaster,
    AbstractPostDispatchHook,
    IGasOracle,
    Indexed,
    OwnableUpgradeable,
    EnumerableDomainSet
{
    using Address for address payable;
    using SafeERC20 for IERC20;
    using Message for bytes;
    using StandardHookMetadata for bytes;
    // ============ Constants ============

    /// @notice The scale of gas oracle token exchange rates.
    uint256 internal constant TOKEN_EXCHANGE_RATE_SCALE = 1e10;
    /// @notice default for user call if metadata not provided
    uint256 internal immutable DEFAULT_GAS_USAGE = 50_000;
    /// @notice Sentinel address for native gas oracle lookups in tokenGasOracles
    address public constant NATIVE_TOKEN = address(0);

    // ============ Public Storage ============

    /// @dev Deprecated storage slot, previously destinationGasConfigs mapping.
    uint256 private __deprecated_destinationGasConfigs;

    /// @notice The benficiary that can receive native tokens paid into this contract.
    address public beneficiary;

    /// @notice Token => destination domain => gas oracle for token payments.
    /// @dev Use NATIVE_TOKEN (address(0)) as the feeToken key for native gas payments.
    mapping(address feeToken => mapping(uint32 destinationDomain => IGasOracle gasOracle))
        public tokenGasOracles;

    /// @notice Destination domain => gas overhead amount.
    /// @dev This replaces the gasOverhead field from destinationGasConfigs.
    mapping(uint32 destinationDomain => uint256 gasOverhead)
        public destinationGasOverhead;

    // ============ Events ============

    /**
     * @notice Emitted when the gas oracle for a remote domain is set.
     * @param remoteDomain The remote domain.
     * @param gasOracle The gas oracle.
     * @param gasOverhead The destination gas overhead.
     */
    event DestinationGasConfigSet(
        uint32 remoteDomain,
        address gasOracle,
        uint96 gasOverhead
    );

    /**
     * @notice Emitted when the beneficiary is set.
     * @param beneficiary The new beneficiary.
     */
    event BeneficiarySet(address beneficiary);

    struct DomainGasConfig {
        IGasOracle gasOracle;
        uint96 gasOverhead;
    }

    struct GasParam {
        uint32 remoteDomain;
        DomainGasConfig config;
    }

    struct TokenGasOracleConfig {
        address feeToken;
        uint32 remoteDomain;
        IGasOracle gasOracle;
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER);
    }

    /**
     * @param _owner The owner of the contract.
     * @param _beneficiary The beneficiary.
     */
    function initialize(
        address _owner,
        address _beneficiary
    ) public initializer {
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
        require(success, "IGP: claim failed");
    }

    /**
     * @notice Transfers the entire balance of a token to the beneficiary.
     * @param _token The token to claim.
     */
    function claimToken(address _token) external {
        uint256 _balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(beneficiary, _balance);
    }

    /**
     * @notice Sets the gas oracles for remote domains specified in the config array.
     * @dev @deprecated Use setTokenGasOracles for oracles and setDestinationGasOverhead for overhead instead.
     * This function still works for backward compatibility, but is not recommended for new deployments.
     * @param _configs An array of configs including the remote domain and gas oracles to set.
     */
    function setDestinationGasConfigs(
        GasParam[] calldata _configs
    ) external onlyOwner {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            _setDestinationGasConfig(
                _configs[i].remoteDomain,
                _configs[i].config.gasOracle,
                _configs[i].config.gasOverhead
            );
        }
    }

    /**
     * @notice Sets the gas oracles for token payments.
     * @dev Use NATIVE_TOKEN (address(0)) as feeToken for native gas payments.
     * @param _configs An array of token gas oracle configs to set.
     */
    function setTokenGasOracles(
        TokenGasOracleConfig[] calldata _configs
    ) external onlyOwner {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            _setTokenGasOracle(
                _configs[i].feeToken,
                _configs[i].remoteDomain,
                _configs[i].gasOracle
            );
        }
    }

    /**
     * @notice Sets the gas overhead for a remote domain.
     * @param _remoteDomain The remote domain.
     * @param _gasOverhead The gas overhead amount.
     */
    function setDestinationGasOverhead(
        uint32 _remoteDomain,
        uint256 _gasOverhead
    ) external onlyOwner {
        destinationGasOverhead[_remoteDomain] = _gasOverhead;
        emit DestinationGasOverheadSet(_remoteDomain, _gasOverhead);
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
        uint256 _payment = quoteGasPayment(_destinationDomain, _gasLimit);
        _payForGas(
            NATIVE_TOKEN,
            _messageId,
            _destinationDomain,
            _gasLimit,
            _refundAddress,
            _payment
        );
    }

    /**
     * @notice Pays for gas using an ERC20 token.
     * @dev Requires prior approval of the fee token. The exact quoted amount is transferred.
     * @param _feeToken The token to pay gas fees in.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     */
    function payForGas(
        address _feeToken,
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) external {
        uint256 _payment = quoteGasPayment(
            _feeToken,
            _destinationDomain,
            _gasLimit
        );
        _payForGas(
            _feeToken,
            _messageId,
            _destinationDomain,
            _gasLimit,
            msg.sender,
            _payment
        );
    }

    /**
     * @notice Quotes the amount of native tokens to pay for interchain gas.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @return The amount of native tokens required to pay for interchain gas.
     */
    // solhint-disable-next-line hyperlane/no-virtual-override
    function quoteGasPayment(
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view virtual override returns (uint256) {
        // Delegate to token version using NATIVE_TOKEN (address(0))
        return quoteGasPayment(NATIVE_TOKEN, _destinationDomain, _gasLimit);
    }

    /**
     * @notice Quotes the amount of a specific token required to pay for gas.
     * @dev Uses tokenGasOracles for oracle lookup and destinationGasOverhead for overhead.
     *      Use NATIVE_TOKEN (address(0)) for native gas payments.
     * @param _feeToken The token to pay gas fees in, or NATIVE_TOKEN for native.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @return The amount of tokens required.
     */
    function quoteGasPayment(
        address _feeToken,
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view virtual returns (uint256) {
        IGasOracle _oracle = tokenGasOracles[_feeToken][_destinationDomain];
        require(
            address(_oracle) != address(0),
            string.concat(
                "IGP: no gas oracle for domain ",
                Strings.toString(_destinationDomain)
            )
        );
        (uint128 _tokenExchangeRate, uint128 _gasPrice) = _oracle
            .getExchangeRateAndGasPrice(_destinationDomain);
        uint256 _destinationGasCost = _gasLimit * uint256(_gasPrice);
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
    function getExchangeRateAndGasPrice(
        uint32 _destinationDomain
    )
        public
        view
        override
        returns (uint128 tokenExchangeRate, uint128 gasPrice)
    {
        IGasOracle _gasOracle = tokenGasOracles[NATIVE_TOKEN][
            _destinationDomain
        ];

        if (address(_gasOracle) == address(0)) {
            revert(
                string.concat(
                    "Configured IGP doesn't support domain ",
                    Strings.toString(_destinationDomain)
                )
            );
        }
        return _gasOracle.getExchangeRateAndGasPrice(_destinationDomain);
    }

    /**
     * @notice Returns the stored destinationGasOverhead added to the _gasLimit.
     * @dev If there is no stored destinationGasOverhead, 0 is used. This is useful in the case
     *      the ISM deployer wants to subsidize the overhead gas cost. Then, can specify the gas oracle
     *      they want to use with the destination domain, but set the overhead to 0.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for. This is only for application gas usage as
     *      the gas usage for the mailbox and the ISM is already accounted in destinationGasOverhead.
     */
    function destinationGasLimit(
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view returns (uint256) {
        return uint256(destinationGasOverhead[_destinationDomain]) + _gasLimit;
    }

    /**
     * @notice Returns the gas oracle and overhead for a destination domain.
     * @dev Reads from tokenGasOracles and destinationGasOverhead storage.
     * @param _destinationDomain The destination domain.
     * @return gasOracle The gas oracle for the destination domain.
     * @return gasOverhead The gas overhead for the destination domain.
     */
    function destinationGasConfigs(
        uint32 _destinationDomain
    ) public view returns (IGasOracle gasOracle, uint96 gasOverhead) {
        return (
            tokenGasOracles[NATIVE_TOKEN][_destinationDomain],
            uint96(destinationGasOverhead[_destinationDomain])
        );
    }

    // ============ Internal Functions ============

    /**
     * @notice Internal helper to handle gas payments for both native and ERC20 tokens.
     * @dev For native: checks msg.value >= payment and refunds overpayment to _payer.
     *      For tokens: transfers exact payment amount from _payer.
     * @param _feeToken The token to pay with, or NATIVE_TOKEN (address(0)) for native.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The domain of the message's destination chain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @param _payerOrRefundAddress For native: refund address. For tokens: address to transfer from.
     * @param _payment The payment amount (from quoteGasPayment).
     */
    function _payForGas(
        address _feeToken,
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasLimit,
        address _payerOrRefundAddress,
        uint256 _payment
    ) internal {
        if (_feeToken == address(0)) {
            // Native payment: check msg.value and refund overpayment
            require(
                msg.value >= _payment,
                "IGP: insufficient interchain gas payment"
            );
            uint256 _overpayment = msg.value - _payment;
            if (_overpayment > 0) {
                require(
                    _payerOrRefundAddress != address(0),
                    "no refund address"
                );
                payable(_payerOrRefundAddress).sendValue(_overpayment);
            }
        } else {
            // Token payment: transfer exact amount from payer
            IERC20(_feeToken).safeTransferFrom(
                _payerOrRefundAddress,
                address(this),
                _payment
            );
        }

        emit GasPayment(_messageId, _destinationDomain, _gasLimit, _payment);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        address _feeToken = metadata.feeToken(address(0));
        uint32 _destinationDomain = message.destination();
        uint256 _gasLimit = destinationGasLimit(
            _destinationDomain,
            metadata.gasLimit(DEFAULT_GAS_USAGE)
        );

        uint256 _payment = quoteGasPayment(
            _feeToken,
            _destinationDomain,
            _gasLimit
        );

        address _payerOrRefundAddress = _feeToken == address(0)
            ? metadata.refundAddress(message.senderAddress())
            : message.senderAddress();

        _payForGas(
            _feeToken,
            message.id(),
            _destinationDomain,
            _gasLimit,
            _payerOrRefundAddress,
            _payment
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        address _feeToken = metadata.feeToken(address(0));
        uint32 _destinationDomain = message.destination();
        uint256 _gasLimit = metadata.gasLimit(DEFAULT_GAS_USAGE);
        return
            quoteGasPayment(
                _feeToken,
                _destinationDomain,
                destinationGasLimit(_destinationDomain, _gasLimit)
            );
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
     * @notice Sets the gas oracle for a token and remote domain.
     * @param _feeToken The fee token address (use NATIVE_TOKEN for native payments).
     * @param _remoteDomain The remote domain.
     * @param _gasOracle The gas oracle.
     */
    function _setTokenGasOracle(
        address _feeToken,
        uint32 _remoteDomain,
        IGasOracle _gasOracle
    ) internal {
        tokenGasOracles[_feeToken][_remoteDomain] = _gasOracle;

        if (_feeToken == NATIVE_TOKEN) {
            // Native token controls domain tracking
            if (address(_gasOracle) == address(0)) {
                _removeDomain(_remoteDomain);
            } else {
                _addDomain(_remoteDomain);
            }
        } else if (address(_gasOracle) != address(0)) {
            // Non-native tokens require domain to already exist
            require(
                address(tokenGasOracles[NATIVE_TOKEN][_remoteDomain]) !=
                    address(0),
                "InterchainGasPaymaster: domain not configured"
            );
        }

        emit TokenGasOracleSet(_feeToken, _remoteDomain, address(_gasOracle));
    }

    /**
     * @notice Sets the gas oracle and destination gas overhead for a remote domain.
     * @dev Writes to both legacy destinationGasConfigs and new tokenGasOracles/destinationGasOverhead
     *      storage for backward compatibility.
     * @param _remoteDomain The remote domain.
     * @param _gasOracle The gas oracle.
     * @param _gasOverhead The destination gas overhead.
     */
    function _setDestinationGasConfig(
        uint32 _remoteDomain,
        IGasOracle _gasOracle,
        uint96 _gasOverhead
    ) internal {
        // Write to new storage
        tokenGasOracles[NATIVE_TOKEN][_remoteDomain] = _gasOracle;
        destinationGasOverhead[_remoteDomain] = _gasOverhead;

        if (address(_gasOracle) == address(0)) {
            _removeDomain(_remoteDomain);
        } else {
            _addDomain(_remoteDomain);
        }

        emit DestinationGasConfigSet(
            _remoteDomain,
            address(_gasOracle),
            _gasOverhead
        );
    }
}
