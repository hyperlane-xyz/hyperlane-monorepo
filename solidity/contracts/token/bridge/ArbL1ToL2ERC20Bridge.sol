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

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {IL1GatewayRouter} from "../../interfaces/arbitrum/IL1GatewayRouter.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbL1ToL2ERC20Bridge
 * @notice ITokenBridge adapter for Arbitrum L1→L2 ERC20 deposits via the Gateway Router
 * @dev Used for rebalancing collateral from L1 to Arbitrum L2
 * @dev L1→L2 deposits on Arbitrum are fast (~10 minutes) but require prepaying L2 gas via retryable tickets
 * @dev Fully immutable - fee parameters are set at deployment and cannot be changed
 */
contract ArbL1ToL2ERC20Bridge is ITokenBridge {
    using SafeERC20 for IERC20;
    using TypeCasts for bytes32;
    using Address for address;

    // ============ Events ============

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    // ============ Immutables ============

    /// @notice The Arbitrum L1 Gateway Router contract
    IL1GatewayRouter public immutable l1GatewayRouter;

    /// @notice The L1 ERC20 token this bridge handles
    address public immutable localToken;

    /// @notice Max gas deducted from user's L2 balance to cover base submission fee
    uint256 public immutable maxSubmissionCost;

    /// @notice Max gas for L2 execution
    uint256 public immutable maxGas;

    /// @notice Gas price bid for L2 execution
    uint256 public immutable gasPriceBid;

    // ============ Constructor ============

    /**
     * @notice Constructor
     * @param _l1GatewayRouter Address of the Arbitrum L1 Gateway Router
     * @param _localToken Address of the L1 ERC20 token
     * @param _maxSubmissionCost Max gas deducted from user's L2 balance for base submission fee
     * @param _maxGas Max gas for L2 execution
     * @param _gasPriceBid Gas price bid for L2 execution
     */
    constructor(
        address _l1GatewayRouter,
        address _localToken,
        uint256 _maxSubmissionCost,
        uint256 _maxGas,
        uint256 _gasPriceBid
    ) {
        require(
            _l1GatewayRouter.isContract(),
            "Gateway router must be a contract"
        );
        require(_localToken.isContract(), "Local token must be a contract");

        l1GatewayRouter = IL1GatewayRouter(_l1GatewayRouter);
        localToken = _localToken;
        maxSubmissionCost = _maxSubmissionCost;
        maxGas = _maxGas;
        gasPriceBid = _gasPriceBid;

        // Approve the gateway to spend tokens
        address gateway = l1GatewayRouter.getGateway(_localToken);
        require(gateway != address(0), "No gateway for token");
        IERC20(_localToken).forceApprove(gateway, type(uint256).max);
    }

    // ============ External Functions ============

    /**
     * @notice Quote the fees for transferring tokens to L2
     * @dev Arbitrum L1→L2 deposits require prepaying L2 gas via retryable tickets
     * @return quotes Array containing the native ETH fee required
     */
    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        // Fee = maxSubmissionCost + (maxGas * gasPriceBid)
        quotes[0] = Quote(address(0), maxSubmissionCost + maxGas * gasPriceBid);
        return quotes;
    }

    /**
     * @notice Transfer tokens from L1 to L2 via the Arbitrum Gateway Router
     * @param _destination Unused (destination is determined by the gateway)
     * @param _recipient Recipient address on L2
     * @param _amount Amount of tokens to transfer
     * @return transferId A unique identifier for the transfer
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        require(_amount > 0, "Amount must be greater than 0");

        uint256 requiredFee = maxSubmissionCost + maxGas * gasPriceBid;
        require(msg.value >= requiredFee, "Insufficient native fee");

        address recipient = _recipient.bytes32ToAddress();

        // Transfer tokens from caller to this contract
        IERC20(localToken).safeTransferFrom(msg.sender, address(this), _amount);

        // Encode the data for the gateway
        // Format: (maxSubmissionCost, callHookData)
        // callHookData is empty for standard transfers
        bytes memory data = abi.encode(maxSubmissionCost, bytes(""));

        // Bridge tokens to L2 via the gateway router
        l1GatewayRouter.outboundTransferCustomRefund{value: msg.value}(
            localToken,
            recipient, // refundTo - excess gas refund goes to recipient on L2
            recipient, // to - token recipient on L2
            _amount,
            maxGas,
            gasPriceBid,
            data
        );

        emit SentTransferRemote(_destination, _recipient, _amount);

        return bytes32(0);
    }
}
