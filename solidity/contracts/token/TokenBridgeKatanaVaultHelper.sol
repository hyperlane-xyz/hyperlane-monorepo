// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IKatanaVaultComposer} from "./interfaces/IKatanaVaultComposer.sol";
import {IKatanaVaultRedeemer} from "./interfaces/IKatanaVaultRedeemer.sol";
import {IVaultBridgeToken} from "./interfaces/IVaultBridgeToken.sol";
import {IOFT, SendParam, MessagingFee} from "./interfaces/layerzero/IOFT.sol";

/**
 * @title TokenBridgeKatanaVaultHelper
 * @notice Ethereum-side helper for the Katana USDC/vbUSDC bridge flow.
 * @dev Outbound transfers deposit USDC into the Katana vault composer.
 *      Inbound redemptions are permissionless and always pay the fixed beneficiary.
 * @dev Alternatives considered:
 *      - AggLayer-specific bridging was rejected because Katana already exposes
 *        the vault + LayerZero OFT path we need.
 *      - A dynamic redeem beneficiary was rejected for now in favor of a
 *        route-specific fixed beneficiary to keep the reasoning and config
 *        surface smaller.
 *      - An ICA-owned balance on Ethereum was rejected; this helper holds the
 *        inbound vbUSDC directly and the ICA only needs to poke redemption.
 */
contract TokenBridgeKatanaVaultHelper is
    ITokenBridge,
    IKatanaVaultRedeemer,
    Ownable,
    PackageVersioned
{
    using SafeERC20 for IERC20;

    error TokenBridgeKatanaVaultHelper__UnsupportedDestination(
        uint32 destination
    );
    error TokenBridgeKatanaVaultHelper__UnexpectedRecipient(
        bytes32 expectedRecipient,
        bytes32 actualRecipient
    );
    error TokenBridgeKatanaVaultHelper__ZeroAddress();
    error TokenBridgeKatanaVaultHelper__InsufficientShares(
        uint256 expectedShares,
        uint256 actualShares
    );
    error TokenBridgeKatanaVaultHelper__InsufficientAssetsOut(
        uint256 minAssetsOut,
        uint256 actualAssetsOut
    );

    event KatanaExtraOptionsSet(bytes extraOptions);
    event TransferRemoteInitiated(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 assets,
        uint256 expectedShares,
        bytes32 transferId
    );
    event RedemptionCompleted(
        address indexed redeemer,
        uint256 shares,
        uint256 assetsOut
    );

    IERC20 public immutable usdc;
    IVaultBridgeToken public immutable vbUsdc;
    IKatanaVaultComposer public immutable composer;
    IOFT public immutable ethShareOftAdapter;
    uint32 public immutable katanaDomain;
    uint32 public immutable katanaLzEid;
    bytes32 public immutable katanaRecipient;
    address public immutable beneficiary;

    bytes public katanaExtraOptions;
    uint256 public nonce;

    constructor(
        address _usdc,
        address _vbUsdc,
        address _composer,
        address _ethShareOftAdapter,
        uint32 _katanaDomain,
        uint32 _katanaLzEid,
        bytes32 _katanaRecipient,
        address _beneficiary,
        address _owner
    ) {
        if (
            _usdc == address(0) || _vbUsdc == address(0)
                || _composer == address(0)
                || _ethShareOftAdapter == address(0)
                || _beneficiary == address(0) || _owner == address(0)
        ) revert TokenBridgeKatanaVaultHelper__ZeroAddress();

        usdc = IERC20(_usdc);
        vbUsdc = IVaultBridgeToken(_vbUsdc);
        composer = IKatanaVaultComposer(_composer);
        ethShareOftAdapter = IOFT(_ethShareOftAdapter);
        katanaDomain = _katanaDomain;
        katanaLzEid = _katanaLzEid;
        katanaRecipient = _katanaRecipient;
        beneficiary = _beneficiary;

        usdc.forceApprove(_composer, type(uint256).max);
        _transferOwnership(_owner);
    }

    function token() public view returns (address) {
        return address(usdc);
    }

    function setKatanaExtraOptions(
        bytes calldata _extraOptions
    ) external onlyOwner {
        katanaExtraOptions = _extraOptions;
        emit KatanaExtraOptionsSet(_extraOptions);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        _checkOutbound(_destination, _recipient);

        uint256 expectedShares = vbUsdc.previewDeposit(_amount);
        uint256 nativeFee = _quoteGasPayment(expectedShares);

        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: nativeFee});
        quotes[1] = Quote({token: address(usdc), amount: _amount});
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        _checkOutbound(_destination, _recipient);

        uint256 expectedShares = vbUsdc.previewDeposit(_amount);
        usdc.safeTransferFrom(msg.sender, address(this), _amount);

        composer.depositAndSend{value: msg.value}(
            _amount,
            _buildSendParam(expectedShares),
            msg.sender
        );

        transferId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                nonce++,
                msg.sender,
                _destination,
                _recipient,
                _amount,
                expectedShares
            )
        );

        emit TransferRemoteInitiated(
            _destination,
            _recipient,
            _amount,
            expectedShares,
            transferId
        );
    }

    function redeem(
        uint256 _shares,
        uint256 _minAssetsOut
    ) external returns (uint256 assetsOut) {
        uint256 balance = IERC20(address(vbUsdc)).balanceOf(address(this));
        if (balance < _shares) {
            revert TokenBridgeKatanaVaultHelper__InsufficientShares(
                _shares,
                balance
            );
        }

        assetsOut = vbUsdc.redeem(_shares, beneficiary, address(this));
        if (assetsOut < _minAssetsOut) {
            revert TokenBridgeKatanaVaultHelper__InsufficientAssetsOut(
                _minAssetsOut,
                assetsOut
            );
        }

        emit RedemptionCompleted(msg.sender, _shares, assetsOut);
    }

    function _checkOutbound(uint32 _destination, bytes32 _recipient)
        internal
        view
    {
        if (_destination != katanaDomain) {
            revert TokenBridgeKatanaVaultHelper__UnsupportedDestination(
                _destination
            );
        }
        if (_recipient != katanaRecipient) {
            revert TokenBridgeKatanaVaultHelper__UnexpectedRecipient(
                katanaRecipient,
                _recipient
            );
        }
    }

    function _buildSendParam(
        uint256 _shares
    ) internal view returns (SendParam memory) {
        return SendParam({
            dstEid: katanaLzEid,
            to: katanaRecipient,
            amountLD: _shares,
            minAmountLD: _shares,
            extraOptions: katanaExtraOptions,
            composeMsg: "",
            oftCmd: ""
        });
    }

    function _quoteGasPayment(
        uint256 _shares
    ) internal view returns (uint256) {
        MessagingFee memory msgFee = ethShareOftAdapter.quoteSend(
            _buildSendParam(_shares),
            false
        );
        return msgFee.nativeFee;
    }
}
