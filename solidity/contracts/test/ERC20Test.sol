// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "../token/interfaces/IXERC20Lockbox.sol";
import "../token/interfaces/IXERC20.sol";
import "../token/interfaces/IXERC20VS.sol";
import "../token/interfaces/IFiatToken.sol";

contract ERC20Test is ERC20 {
    uint8 public immutable _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20(name, symbol) {
        _decimals = __decimals;
        _mint(msg.sender, totalSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(uint256 amount) public {
        _mint(msg.sender, amount);
    }

    function mintTo(address account, uint256 amount) public {
        _mint(account, amount);
    }

    function burnFrom(address account, uint256 amount) public {
        _burn(account, amount);
    }
}

contract FiatTokenTest is ERC20Test, IFiatToken {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) {}

    function burn(uint256 amount) public override {
        _burn(msg.sender, amount);
    }

    function mint(address account, uint256 amount) public returns (bool) {
        _mint(account, amount);
        return true;
    }
}

contract XERC20Test is ERC20Test, Ownable, IXERC20 {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) Ownable() {}

    function initialize() external {
        _transferOwnership(msg.sender);
    }

    function mint(address account, uint256 amount) public override {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public override {
        _burn(account, amount);
    }

    function setLimits(address, uint256, uint256) external pure {
        assert(false);
    }

    function owner() public view override(Ownable, IXERC20) returns (address) {
        return Ownable.owner();
    }

    function burningCurrentLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return type(uint256).max;
    }

    function mintingCurrentLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return type(uint256).max;
    }

    function mintingMaxLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return type(uint256).max;
    }

    function burningMaxLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return type(uint256).max;
    }
}

contract XERC20VSTest is ERC20Test, Ownable, IXERC20VS {
    event ConfigurationChanged(
        address indexed bridge,
        uint112 bufferCap,
        uint128 rateLimitPerSecond
    );

    mapping(address bridge => RateLimitMidPoint bridgeRateLimit)
        internal _rateLimits;

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) Ownable() {
        _transferOwnership(msg.sender);
    }

    function initialize() external {
        _transferOwnership(msg.sender);
    }

    function owner() public view override(Ownable) returns (address) {
        return Ownable.owner();
    }

    function lockbox() external view override returns (address) {
        return address(0);
    }

    function rateLimits(
        address _bridge
    ) external view override returns (RateLimitMidPoint memory _rateLimit) {
        return _rateLimits[_bridge];
    }

    function mintingMaxLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return _rateLimits[_bridge].bufferCap;
    }

    function burningMaxLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return _rateLimits[_bridge].bufferCap;
    }

    function burningCurrentLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return _rateLimits[_bridge].bufferCap - _buffer(_rateLimits[_bridge]);
    }

    function mintingCurrentLimitOf(
        address _bridge
    ) external view returns (uint256) {
        return _buffer(_rateLimits[_bridge]);
    }

    function mint(address account, uint256 amount) public override {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public override {
        _burn(account, amount);
    }

    function setBufferCap(
        address _bridge,
        uint256 _newBufferCap
    ) external override {}

    function setRateLimitPerSecond(
        address _bridge,
        uint128 _newRateLimitPerSecond
    ) external override {}

    function addBridge(
        RateLimitMidPointInfo memory rateLimit
    ) external onlyOwner {
        _rateLimits[rateLimit.bridge] = RateLimitMidPoint({
            bufferCap: rateLimit.bufferCap,
            lastBufferUsedTime: uint32(block.timestamp),
            bufferStored: uint112(rateLimit.bufferCap / 2),
            midPoint: uint112(rateLimit.bufferCap / 2),
            rateLimitPerSecond: rateLimit.rateLimitPerSecond
        });

        emit ConfigurationChanged(
            rateLimit.bridge,
            rateLimit.bufferCap,
            rateLimit.rateLimitPerSecond
        );
    }

    function removeBridge(address _bridge) external override {
        delete _rateLimits[_bridge];
    }

    function _buffer(
        RateLimitMidPoint storage limit
    ) internal view returns (uint256) {
        uint256 elapsed;
        unchecked {
            elapsed = uint32(block.timestamp) - limit.lastBufferUsedTime;
        }

        uint256 accrued = uint256(limit.rateLimitPerSecond) * elapsed;
        if (limit.bufferStored < limit.midPoint) {
            return
                Math.min(
                    uint256(limit.bufferStored) + accrued,
                    uint256(limit.midPoint)
                );
        } else if (limit.bufferStored > limit.midPoint) {
            /// past midpoint so subtract accrued off bufferStored back down to midpoint

            /// second part of if statement will not be evaluated if first part is true
            if (
                accrued > limit.bufferStored ||
                limit.bufferStored - accrued < limit.midPoint
            ) {
                /// if accrued is more than buffer stored, subtracting will underflow,
                /// and we are at the midpoint, so return that
                return limit.midPoint;
            } else {
                return limit.bufferStored - accrued;
            }
        } else {
            /// no change
            return limit.bufferStored;
        }
    }

    function rateLimitPerSecond(address from) public view returns (uint256) {
        return _rateLimits[from].rateLimitPerSecond;
    }

    function bufferCap(address from) public view returns (uint256) {
        return _rateLimits[from].bufferCap;
    }
}

contract XERC20LockboxTest is IXERC20Lockbox {
    IXERC20 public immutable XERC20;
    IERC20 public immutable ERC20;

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) {
        ERC20Test erc20 = new ERC20Test(name, symbol, totalSupply, __decimals);
        erc20.transfer(msg.sender, totalSupply);
        ERC20 = erc20;
        XERC20 = new XERC20Test(name, symbol, 0, __decimals);
    }

    function depositTo(address _user, uint256 _amount) public {
        ERC20.transferFrom(msg.sender, address(this), _amount);
        XERC20.mint(_user, _amount);
    }

    function deposit(uint256 _amount) external {
        depositTo(msg.sender, _amount);
    }

    function depositNativeTo(address) external payable {
        assert(false);
    }

    function withdrawTo(address _user, uint256 _amount) public {
        XERC20.burn(msg.sender, _amount);
        ERC20Test(address(ERC20)).mintTo(_user, _amount);
    }

    function withdraw(uint256 _amount) external {
        withdrawTo(msg.sender, _amount);
    }
}
