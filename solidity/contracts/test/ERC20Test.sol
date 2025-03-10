// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../token/interfaces/IXERC20Lockbox.sol";
import "../token/interfaces/IXERC20.sol";
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

contract XERC20Test is ERC20Test, IXERC20 {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) {}

    function mint(address account, uint256 amount) public override {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public override {
        _burn(account, amount);
    }

    function setLimits(address, uint256, uint256) external pure {
        assert(false);
    }

    function owner() external pure returns (address) {
        return address(0x0);
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
