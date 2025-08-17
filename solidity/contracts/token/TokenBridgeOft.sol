// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ValueTransferBridge, Quote} from "./interfaces/ValueTransferBridge.sol";
import {IOFTCore} from "./interfaces/IOFTCore.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TokenBridgeOft is ValueTransferBridge, Ownable {
    struct DomainConfig {
        uint16 lzChainId;
        bytes dstVault;
        bytes adapterParams;
        bool exists;
    }

    IERC20 public immutable collateral;
    mapping(uint32 => DomainConfig) internal _domainConfig;

    event DomainConfigured(uint32 indexed hyperlaneDomain, uint16 lzChainId, bytes dstVault);
    event AdapterParamsSet(uint32 indexed hyperlaneDomain, bytes adapterParams);

    constructor(address _collateral, address _owner) {
        require(_collateral != address(0), "invalid token");
        collateral = IERC20(_collateral);
        _transferOwnership(_owner);
    }

    function configureDomain(
        uint32 hyperlaneDomain,
        uint16 lzChainId,
        bytes calldata dstVault,
        bytes calldata adapterParams
    ) external onlyOwner {
        _domainConfig[hyperlaneDomain] = DomainConfig({
            lzChainId: lzChainId,
            dstVault: dstVault,
            adapterParams: adapterParams,
            exists: true
        });
        emit DomainConfigured(hyperlaneDomain, lzChainId, dstVault);
        emit AdapterParamsSet(hyperlaneDomain, adapterParams);
    }

    function setAdapterParams(uint32 hyperlaneDomain, bytes calldata adapterParams) external onlyOwner {
        DomainConfig storage cfg = _domainConfig[hyperlaneDomain];
        require(cfg.exists, "domain not configured");
        cfg.adapterParams = adapterParams;
        emit AdapterParamsSet(hyperlaneDomain, adapterParams);
    }

    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({token: address(0), amount: 0});
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32,
        uint256 amountOut
    ) external payable override returns (bytes32 transferId) {
        DomainConfig memory cfg = _domainConfig[destinationDomain];
        require(cfg.exists, "domain not configured");

        uint256 allowance = collateral.allowance(msg.sender, address(this));
        require(allowance >= amountOut, "insufficient allowance");

        collateral.transferFrom(msg.sender, address(this), amountOut);

        IOFTCore(address(collateral)).sendFrom{value: msg.value}(
            address(this),
            cfg.lzChainId,
            cfg.dstVault,
            amountOut,
            cfg.adapterParams
        );

        transferId = bytes32(0);
    }
}
