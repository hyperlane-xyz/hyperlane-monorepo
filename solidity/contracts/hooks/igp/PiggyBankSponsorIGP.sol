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
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";

// ============ External Imports ============
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PiggyBankSponsorIGP
 * @notice A pre-funded IGP that allows app developers (sponsors) to pay for
 * their users' interchain gas. The sponsor deposits tokens into this contract,
 * and when a user dispatches a message through a configured app, gas costs are
 * deducted from the sponsor's balance instead of requiring the user to pay.
 *
 * Key features:
 * - Sponsor deposits funds (native or ERC20) to cover users' gas costs
 * - Uses a configured gas oracle for pricing (same mechanism as InterchainGasPaymaster)
 * - Beneficiary can claim accumulated payments
 * - Sponsor can withdraw unused funds
 * - Emits standard GasPayment events for relayer compatibility
 * - Low-balance threshold warning for proactive top-ups
 *
 * @dev Each deployment is intended for a single sponsor/app. For multi-sponsor
 * scenarios, deploy separate instances.
 */
contract PiggyBankSponsorIGP is AbstractPostDispatchHook, Ownable {
    using Address for address payable;
    using SafeERC20 for IERC20;
    using Message for bytes;
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    /// @notice The scale of gas oracle token exchange rates.
    uint256 internal constant TOKEN_EXCHANGE_RATE_SCALE = 1e10;
    /// @notice Default gas usage if metadata doesn't specify one.
    uint256 internal constant DEFAULT_GAS_USAGE = 50_000;
    /// @notice Sentinel address for native gas oracle lookups.
    address public constant NATIVE_TOKEN = address(0);

    // ============ Public Storage ============

    /// @notice The sponsor who funds gas payments.
    address public sponsor;

    /// @notice The sponsor's deposited balance (native tokens).
    uint256 public sponsorBalance;

    /// @notice Accumulated gas payments collected (awaiting beneficiary claim).
    uint256 public collectedPayments;

    /// @notice The beneficiary who can claim collected payments.
    address public beneficiary;

    /// @notice Token => destination domain => gas oracle for token payments.
    /// @dev Use NATIVE_TOKEN (address(0)) as the feeToken key for native gas payments.
    mapping(address feeToken => mapping(uint32 destinationDomain => IGasOracle gasOracle))
        public tokenGasOracles;

    /// @notice Destination domain => gas overhead amount.
    mapping(uint32 destinationDomain => uint256 gasOverhead)
        public destinationGasOverhead;

    /// @notice Low-balance threshold in native token. Emits LowBalance warning when sponsorBalance drops below this.
    uint256 public lowBalanceThreshold;

    // ============ Events ============

    /**
     * @notice Emitted when a gas payment is made from the sponsor's balance.
     */
    event GasPayment(
        bytes32 indexed messageId,
        uint32 indexed destinationDomain,
        uint256 gasAmount,
        uint256 payment
    );

    /**
     * @notice Emitted when the sponsor deposits funds.
     */
    event Deposited(address indexed sponsor, uint256 amount);

    /**
     * @notice Emitted when the sponsor withdraws funds.
     */
    event Withdrawn(address indexed sponsor, uint256 amount);

    /**
     * @notice Emitted when the beneficiary collects payments.
     */
    event Collected(address indexed beneficiary, uint256 amount);

    /**
     * @notice Emitted when the beneficiary is set.
     */
    event BeneficiarySet(address indexed beneficiary);

    /**
     * @notice Emitted when the sponsor balance drops below the low-balance threshold.
     */
    event LowBalanceWarning(
        address indexed sponsor,
        uint256 remainingBalance,
        uint256 threshold
    );

    /**
     * @notice Emitted when a token gas oracle is set.
     */
    event TokenGasOracleSet(
        address indexed feeToken,
        uint32 remoteDomain,
        address gasOracle
    );

    /**
     * @notice Emitted when the gas overhead for a remote domain is set.
     */
    event DestinationGasOverheadSet(
        uint32 indexed remoteDomain,
        uint256 gasOverhead
    );

    /**
     * @notice Emitted when the low-balance threshold is set.
     */
    event LowBalanceThresholdSet(uint256 threshold);

    // ============ Constructor ============

    /**
     * @param _sponsor The address that will fund gas payments.
     * @param _beneficiary The address that can claim collected payments.
     * @param _lowBalanceThreshold The threshold below which a LowBalanceWarning is emitted.
     */
    constructor(
        address _sponsor,
        address _beneficiary,
        uint256 _lowBalanceThreshold
    ) Ownable(_sponsor) {
        require(_sponsor != address(0), "PiggyBank: zero sponsor");
        require(_beneficiary != address(0), "PiggyBank: zero beneficiary");
        sponsor = _sponsor;
        beneficiary = _beneficiary;
        lowBalanceThreshold = _lowBalanceThreshold;
    }

    // ============ External Functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.INTERCHAIN_GAS_PAYMASTER);
    }

    /**
     * @notice Sponsor deposits native tokens to fund user gas payments.
     */
    function deposit() external payable {
        require(msg.value > 0, "PiggyBank: zero deposit");
        require(
            msg.sender == sponsor || msg.sender == owner(),
            "PiggyBank: not sponsor"
        );
        sponsorBalance += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Sponsor deposits ERC20 tokens to fund user gas payments.
     * @param _token The ERC20 token address.
     * @param _amount The amount to deposit.
     */
    function depositERC20(address _token, uint256 _amount) external {
        require(_amount > 0, "PiggyBank: zero deposit");
        require(
            msg.sender == sponsor || msg.sender == owner(),
            "PiggyBank: not sponsor"
        );
        require(_token != address(0), "PiggyBank: zero token");
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        // Track ERC20 balances per token
        _creditTokenBalance(_token, _amount);
        emit Deposited(msg.sender, _amount);
    }

    /**
     * @notice Sponsor withdraws unused native tokens.
     * @param _amount The amount to withdraw.
     */
    function withdraw(uint256 _amount) external onlyOwner {
        require(_amount <= sponsorBalance, "PiggyBank: insufficient balance");
        sponsorBalance -= _amount;
        payable(sponsor).sendValue(_amount);
        emit Withdrawn(sponsor, _amount);
    }

    /**
     * @notice Sponsor withdraws unused ERC20 tokens.
     * @param _token The ERC20 token address.
     * @param _amount The amount to withdraw.
     */
    function withdrawERC20(address _token, uint256 _amount) external onlyOwner {
        uint256 balance = _tokenBalance(_token);
        require(_amount <= balance, "PiggyBank: insufficient token balance");
        _debitTokenBalance(_token, _amount);
        IERC20(_token).safeTransfer(sponsor, _amount);
        emit Withdrawn(sponsor, _amount);
    }

    /**
     * @notice Beneficiary claims accumulated native token payments.
     */
    function claim() external {
        require(msg.sender == beneficiary, "PiggyBank: not beneficiary");
        uint256 amount = collectedPayments;
        require(amount > 0, "PiggyBank: nothing to claim");
        collectedPayments = 0;
        payable(beneficiary).sendValue(amount);
        emit Collected(beneficiary, amount);
    }

    /**
     * @notice Beneficiary claims accumulated ERC20 token payments.
     * @param _token The ERC20 token address.
     */
    function claimToken(address _token) external {
        require(msg.sender == beneficiary, "PiggyBank: not beneficiary");
        uint256 amount = _erc20BeneficiaryBalances[_token];
        require(amount > 0, "PiggyBank: nothing to claim");
        _erc20BeneficiaryBalances[_token] = 0;
        IERC20(_token).safeTransfer(beneficiary, amount);
        emit Collected(beneficiary, amount);
    }

    /**
     * @notice Sets the beneficiary.
     * @param _beneficiary The new beneficiary.
     */
    function setBeneficiary(address _beneficiary) external onlyOwner {
        require(_beneficiary != address(0), "PiggyBank: zero address");
        beneficiary = _beneficiary;
        emit BeneficiarySet(_beneficiary);
    }

    /**
     * @notice Sets the low-balance threshold.
     * @param _threshold The new threshold in wei.
     */
    function setLowBalanceThreshold(uint256 _threshold) external onlyOwner {
        lowBalanceThreshold = _threshold;
        emit LowBalanceThresholdSet(_threshold);
    }

    /**
     * @notice Sets the gas oracles for token payments.
     * @param _configs An array of token gas oracle configs.
     */
    struct TokenGasOracleConfig {
        address feeToken;
        uint32 remoteDomain;
        IGasOracle gasOracle;
    }

    function setTokenGasOracles(
        TokenGasOracleConfig[] calldata _configs
    ) external onlyOwner {
        uint256 _len = _configs.length;
        for (uint256 i = 0; i < _len; i++) {
            tokenGasOracles[_configs[i].feeToken][_configs[i].remoteDomain] = _configs[i].gasOracle;
            emit TokenGasOracleSet(
                _configs[i].feeToken,
                _configs[i].remoteDomain,
                address(_configs[i].gasOracle)
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
     * @notice Returns the total destination gas limit (overhead + user gas).
     * @param _destinationDomain The destination domain.
     * @param _gasLimit The user-specified gas limit.
     * @return The total gas limit.
     */
    function destinationGasLimit(
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view returns (uint256) {
        return destinationGasOverhead[_destinationDomain] + _gasLimit;
    }

    // ============ IGP Interface ============

    /**
     * @notice Pay for gas using native tokens (sponsor pays, not the caller).
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The destination domain.
     * @param _gasLimit The amount of destination gas to pay for.
     * @param _refundAddress Unused in sponsor mode (refunds go to sponsor's balance).
     */
    function payForGas(
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasLimit,
        address _refundAddress
    ) external payable {
        uint256 _payment = quoteGasPayment(_destinationDomain, _gasLimit);
        _sponsorPayForGas(
            NATIVE_TOKEN,
            _messageId,
            _destinationDomain,
            _gasLimit,
            _payment
        );
    }

    /**
     * @notice Pay for gas using an ERC20 token (sponsor pays, not the caller).
     * @param _feeToken The token to pay gas fees in.
     * @param _messageId The ID of the message to pay for.
     * @param _destinationDomain The destination domain.
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
        _sponsorPayForGas(
            _feeToken,
            _messageId,
            _destinationDomain,
            _gasLimit,
            _payment
        );
    }

    /**
     * @notice Quotes the amount of native tokens required for gas.
     * @param _destinationDomain The destination domain.
     * @param _gasLimit The amount of destination gas.
     * @return The amount of native tokens required.
     */
    function quoteGasPayment(
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view virtual returns (uint256) {
        return quoteGasPayment(NATIVE_TOKEN, _destinationDomain, _gasLimit);
    }

    /**
     * @notice Quotes the amount of a specific token required for gas.
     * @param _feeToken The fee token address, or NATIVE_TOKEN for native.
     * @param _destinationDomain The destination domain.
     * @param _gasLimit The amount of destination gas.
     * @return The amount of tokens required.
     */
    function quoteGasPayment(
        address _feeToken,
        uint32 _destinationDomain,
        uint256 _gasLimit
    ) public view virtual returns (uint256) {
        (
            uint128 exchangeRate,
            uint128 gasPrice
        ) = _getExchangeRateAndGasPrice(_feeToken, _destinationDomain);
        return _computeGasFee(exchangeRate, gasPrice, _gasLimit);
    }

    // ============ AbstractPostDispatchHook ============

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

        uint256 _payment = _quoteGasPayment(
            _feeToken,
            _destinationDomain,
            _gasLimit,
            message.senderAddress()
        );

        _sponsorPayForGas(
            _feeToken,
            message.id(),
            _destinationDomain,
            _gasLimit,
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
            _quoteGasPayment(
                _feeToken,
                _destinationDomain,
                destinationGasLimit(_destinationDomain, _gasLimit),
                message.senderAddress()
            );
    }

    // ============ Internal Functions ============

    /**
     * @notice Deducts gas payment from the sponsor's balance instead of charging the caller.
     * @param _feeToken The fee token (NATIVE_TOKEN or ERC20).
     * @param _messageId The message ID.
     * @param _destinationDomain The destination domain.
     * @param _gasLimit The gas limit.
     * @param _payment The calculated payment amount.
     */
    function _sponsorPayForGas(
        address _feeToken,
        bytes32 _messageId,
        uint32 _destinationDomain,
        uint256 _gasLimit,
        uint256 _payment
    ) internal {
        require(_payment > 0, "PiggyBank: zero payment");

        if (_feeToken == NATIVE_TOKEN) {
            // Deduct from sponsor's native token balance
            require(
                sponsorBalance >= _payment,
                "PiggyBank: insufficient sponsor balance"
            );
            sponsorBalance -= _payment;
            collectedPayments += _payment;

            // Check low-balance warning
            if (sponsorBalance < lowBalanceThreshold) {
                emit LowBalanceWarning(sponsor, sponsorBalance, lowBalanceThreshold);
            }
        } else {
            // Deduct from sponsor's ERC20 token balance
            uint256 tokenBal = _tokenBalance(_feeToken);
            require(
                tokenBal >= _payment,
                "PiggyBank: insufficient sponsor token balance"
            );
            _debitTokenBalance(_feeToken, _payment);
            _creditTokenBalanceForBeneficiary(_feeToken, _payment);
        }

        emit GasPayment(_messageId, _destinationDomain, _gasLimit, _payment);
    }

    /**
     * @notice Internal quote gas payment with sender context.
     */
    function _quoteGasPayment(
        address _feeToken,
        uint32 _destinationDomain,
        uint256 _gasLimit,
        address /* _sender */
    ) internal view virtual returns (uint256) {
        return quoteGasPayment(_feeToken, _destinationDomain, _gasLimit);
    }

    /**
     * @notice Gets exchange rate and gas price from the configured oracle.
     */
    function _getExchangeRateAndGasPrice(
        address _feeToken,
        uint32 _destinationDomain
    ) internal view virtual returns (uint128, uint128) {
        IGasOracle _oracle = tokenGasOracles[_feeToken][_destinationDomain];
        require(
            address(_oracle) != address(0),
            string.concat(
                "PiggyBank: no gas oracle for domain ",
                Strings.toString(_destinationDomain)
            )
        );
        return _oracle.getExchangeRateAndGasPrice(_destinationDomain);
    }

    /**
     * @notice Computes gas fee from exchange rate, gas price, and gas limit.
     */
    function _computeGasFee(
        uint128 tokenExchangeRate,
        uint128 gasPrice,
        uint256 gasLimit
    ) internal pure returns (uint256) {
        return
            (gasLimit * uint256(gasPrice) * uint256(tokenExchangeRate)) /
            TOKEN_EXCHANGE_RATE_SCALE;
    }

    // ============ ERC20 Balance Tracking ============

    /// @dev token address => balance held for beneficiary claim
    mapping(address => uint256) internal _erc20BeneficiaryBalances;

    /// @dev token address => balance held as sponsor deposit
    mapping(address => uint256) internal _erc20SponsorBalances;

    function _tokenBalance(address _token) internal view returns (uint256) {
        return _erc20SponsorBalances[_token];
    }

    function _creditTokenBalance(address _token, uint256 _amount) internal {
        _erc20SponsorBalances[_token] += _amount;
    }

    function _debitTokenBalance(address _token, uint256 _amount) internal {
        _erc20SponsorBalances[_token] -= _amount;
    }

    function _creditTokenBalanceForBeneficiary(address _token, uint256 _amount) internal {
        _erc20BeneficiaryBalances[_token] += _amount;
    }
}
