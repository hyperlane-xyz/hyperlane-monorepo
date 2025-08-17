/// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {TokenBridgeOft} from "../../contracts/token/TokenBridgeOft.sol";

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IOFTCoreMinimal {
    function sendFrom(
        address from,
        uint16 dstChainId,
        bytes calldata toAddress,
        uint256 amount,
        bytes calldata adapterParams
    ) external payable;
}

contract MockOFTToken is IERC20Minimal, IOFTCoreMinimal {
    string public name = "MockOFT";
    string public symbol = "MOFT";
    uint8 public decimals = 18;

    mapping(address => uint256) public _balances;
    mapping(address => mapping(address => uint256)) public _allowances;

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_balances[msg.sender] >= amount, "insufficient");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "no allowance");
        require(_balances[from] >= amount, "insufficient");
        _allowances[from][msg.sender] = allowed - amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function sendFrom(
        address,
        uint16,
        bytes calldata,
        uint256,
        bytes calldata
    ) external payable {}
}

contract TokenBridgeOftTest is Test {
    TokenBridgeOft oft;
    MockOFTToken token;

    address mailbox = address(0x1234);
    address hook = address(0x1111);
    address ism = address(0x2222);

    function setUp() public {
        token = new MockOFTToken();
        oft = new TokenBridgeOft(address(token), 1, mailbox);
        oft.initialize(hook, ism, address(this));

        token.mint(address(this), 1_000 ether);
        token.approve(address(oft), type(uint256).max);
    }

    function _addrToBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function testInvalidRecipientReverts() public {
        uint32 dest = 1000;
        address enrolled = address(0xAbCd);
        oft.enrollRemoteRouter(dest, _addrToBytes32(enrolled));
        address wrongRecipient = address(0xBEEF);

        vm.expectRevert(bytes("Invalid recipient"));
        oft.transferRemote(dest, _addrToBytes32(wrongRecipient), 1 ether);
    }

    function testMissingEidMappingReverts() public {
        uint32 dest = 1001;
        address enrolled = address(0xCAFE);
        oft.enrollRemoteRouter(dest, _addrToBytes32(enrolled));

        vm.expectRevert(bytes("EID not configured"));
        oft.transferRemote(dest, _addrToBytes32(enrolled), 1 ether);
    }

    function testQuoteParity() public {
        uint32 dest = 1002;
        bytes32 recipient = _addrToBytes32(address(0xF00D));
        uint256 amount = 5 ether;

        (
            address token0,
            uint256 amt0,
            address token1,
            uint256 amt1
        ) = _quoteFlatten(dest, recipient, amount);

        assertEq(token0, address(0));
        assertGt(amt0, 0);
        assertEq(token1, address(token));
        assertEq(amt1, amount);
    }

    function _quoteFlatten(
        uint32 dest,
        bytes32 recipient,
        uint256 amount
    ) internal returns (address, uint256, address, uint256) {
        QuoteCaller qc = new QuoteCaller();
        QuoteCaller.Quote[] memory quotes = qc.quote(
            address(oft),
            dest,
            recipient,
            amount
        );
        address t0 = quotes[0].token;
        uint256 a0 = quotes[0].amount;
        address t1 = quotes[1].token;
        uint256 a1 = quotes[1].amount;
        return (t0, a0, t1, a1);
    }
}

contract QuoteCaller {
    struct Quote {
        address token;
        uint256 amount;
    }

    function quote(
        address bridge,
        uint32 dest,
        bytes32 recipient,
        uint256 amount
    ) external view returns (Quote[] memory) {
        (bool ok, bytes memory data) = bridge.staticcall(
            abi.encodeWithSignature(
                "quoteTransferRemote(uint32,bytes32,uint256)",
                dest,
                recipient,
                amount
            )
        );
        require(ok, "staticcall failed");
        Quote[] memory quotes = abi.decode(data, (Quote[]));
        return quotes;
    }
}
