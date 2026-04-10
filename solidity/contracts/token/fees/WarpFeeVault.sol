// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {PackageVersioned} from "../../PackageVersioned.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title WarpFeeVault
 * @notice ERC4626 entrypoint for a hub router LP position with streamed fee recognition.
 * @dev The vault assumes a plain ERC20 route asset. Native, rebasing, fee-on-transfer,
 * and ERC777 route assets are unsupported.
 */
contract WarpFeeVault is ERC4626, Ownable, ReentrancyGuard, PackageVersioned {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_SCALE = 10_000;
    uint8 public constant DECIMALS_OFFSET = 6;

    struct Stream {
        uint256 remaining;
        uint256 recognized;
        uint256 lastUpdated;
        uint256 end;
    }

    IERC4626 public immutable hubRouter;
    uint256 public lpBps;
    address public protocolBeneficiary;
    uint256 public streamingPeriod;
    Stream public stream;

    event FeesNotified(
        uint256 amount,
        uint256 lpAmount,
        uint256 protocolAmount
    );
    event FeesSettled(uint256 amount);
    event LpBpsSet(address indexed operator, uint256 lpBps);
    event ProtocolBeneficiarySet(
        address indexed operator,
        address indexed protocolBeneficiary
    );
    event StreamingPeriodSet(address indexed operator, uint256 streamingPeriod);

    constructor(
        address _owner,
        IERC20 _asset,
        IERC4626 _hubRouter,
        uint256 _lpBps,
        address _protocolBeneficiary,
        uint256 _streamingPeriod,
        string memory _name,
        string memory _symbol
    ) ERC4626(_asset) ERC20(_name, _symbol) {
        require(_owner != address(0), "WarpFeeVault: owner zero");
        require(address(_asset) != address(0), "WarpFeeVault: asset zero");
        require(address(_hubRouter) != address(0), "WarpFeeVault: router zero");
        require(
            _hubRouter.asset() == address(_asset),
            "WarpFeeVault: asset mismatch"
        );
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeVault: beneficiary zero"
        );
        require(_lpBps <= BPS_SCALE, "WarpFeeVault: lp bps too high");
        require(_streamingPeriod > 0, "WarpFeeVault: streaming period zero");

        hubRouter = _hubRouter;
        lpBps = _lpBps;
        protocolBeneficiary = _protocolBeneficiary;
        streamingPeriod = _streamingPeriod;
        _transferOwnership(_owner);
    }

    /**
     * @notice Splits newly swept fees. Protocol share is transferred immediately;
     * LP share streams into totalAssets() while staying in this vault.
     * @dev If fees are notified before any LP deposits, later depositors will
     * own the streamed LP share pro rata from their deposit onward.
     */
    function notify() external nonReentrant {
        _recognizeVested();

        uint256 balance = IERC20(asset()).balanceOf(address(this));
        uint256 accounted = stream.remaining + stream.recognized;
        require(balance >= accounted, "WarpFeeVault: balance below stream");

        uint256 amount = balance - accounted;
        require(amount > 0, "WarpFeeVault: no new fees");

        uint256 lpAmount = (amount * lpBps) / BPS_SCALE;
        uint256 protocolAmount = amount - lpAmount;

        if (protocolAmount > 0) {
            IERC20(asset()).safeTransfer(protocolBeneficiary, protocolAmount);
        }
        if (lpAmount > 0) {
            _addStream(lpAmount);
        }

        emit FeesNotified(amount, lpAmount, protocolAmount);
    }

    function totalAssets() public view override returns (uint256) {
        return
            hubRouter.convertToAssets(hubRouter.balanceOf(address(this))) +
            stream.recognized +
            previewSettle();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    function previewSettle() public view returns (uint256) {
        Stream memory current = stream;
        if (current.remaining == 0 || block.timestamp <= current.lastUpdated) {
            return 0;
        }
        if (block.timestamp >= current.end) {
            return current.remaining;
        }

        uint256 duration = current.end - current.lastUpdated;
        return
            (current.remaining * (block.timestamp - current.lastUpdated)) /
            duration;
    }

    function deposit(
        uint256 assets,
        address receiver
    ) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(
        uint256 shares,
        address receiver
    ) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal override {
        _recognizeVested();

        IERC20(asset()).safeTransferFrom(caller, address(this), assets);
        IERC20(asset()).forceApprove(address(hubRouter), assets);
        hubRouter.deposit(assets, address(this));
        IERC20(asset()).forceApprove(address(hubRouter), 0);

        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        _recognizeVested();

        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }
        _burn(owner, shares);
        uint256 vaultAssets = stream.recognized;
        uint256 assetsFromVault = assets < vaultAssets ? assets : vaultAssets;
        if (assetsFromVault > 0) {
            stream.recognized -= assetsFromVault;
            IERC20(asset()).safeTransfer(receiver, assetsFromVault);
        }

        uint256 routerAssets = assets - assetsFromVault;
        if (routerAssets > 0) {
            hubRouter.withdraw(routerAssets, receiver, address(this));
        }

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    function _recognizeVested() internal {
        uint256 amount = previewSettle();
        if (amount == 0) {
            return;
        }

        stream.remaining -= amount;
        stream.recognized += amount;
        stream.lastUpdated = block.timestamp;
        if (stream.remaining == 0) {
            stream.end = block.timestamp;
        }

        emit FeesSettled(amount);
    }

    function _addStream(uint256 amount) internal {
        uint256 remaining = stream.remaining;
        if (remaining == 0) {
            stream.remaining = amount;
            stream.lastUpdated = block.timestamp;
            stream.end = block.timestamp + streamingPeriod;
            return;
        }

        uint256 currentTimeLeft = stream.end - block.timestamp;
        uint256 newRemaining = remaining + amount;
        uint256 weightedTimeLeft = ((remaining * currentTimeLeft) +
            (amount * streamingPeriod)) / newRemaining;

        stream.remaining = newRemaining;
        stream.lastUpdated = block.timestamp;
        stream.end = block.timestamp + weightedTimeLeft;
    }

    function setLpBps(uint256 _lpBps) external onlyOwner {
        require(_lpBps <= BPS_SCALE, "WarpFeeVault: lp bps too high");
        lpBps = _lpBps;
        emit LpBpsSet(msg.sender, _lpBps);
    }

    function setProtocolBeneficiary(
        address _protocolBeneficiary
    ) external onlyOwner {
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeVault: beneficiary zero"
        );
        protocolBeneficiary = _protocolBeneficiary;
        emit ProtocolBeneficiarySet(msg.sender, _protocolBeneficiary);
    }

    /**
     * @notice Sets the period used for future fee streams.
     * @dev Existing streams keep their current weighted end time.
     */
    function setStreamingPeriod(uint256 _streamingPeriod) external onlyOwner {
        require(_streamingPeriod > 0, "WarpFeeVault: streaming period zero");
        streamingPeriod = _streamingPeriod;
        emit StreamingPeriodSet(msg.sender, _streamingPeriod);
    }
}
