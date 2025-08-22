// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ValueTransferBridge, Quote} from "../interfaces/ValueTransferBridge.sol";
import {IOFTCore} from "../interfaces/IOFTCore.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TokenBridgeOftAdapterBridge
 * @notice Minimal ValueTransferBridge adapter that wraps LayerZero OFT sendFrom for router-to-router rebalancing.
 * Mirrors the CCTP bridge adapter pattern expected by MovableCollateralRouter.
 */
contract TokenBridgeOftAdapterBridge is ValueTransferBridge, Ownable {
    struct Domain {
        uint32 hyperlane;
        uint16 lzEid;
        bytes dstVault; // destination router vault (bytes-encoded address)
        bytes adapterParams; // LZ adapter params
    }

    // Hyperlane domain -> LZ config
    mapping(uint32 => Domain) internal _domainMap;

    // The OFT token to bridge
    address public immutable oftToken;

    constructor(address _oftToken, address _owner) {
        require(_oftToken != address(0), "invalid oft");
        oftToken = _oftToken;
        _transferOwnership(_owner);
    }

    function addDomain(
        uint32 _hyperlaneDomain,
        uint16 _lzEid,
        bytes calldata _dstVault,
        bytes calldata _adapterParams
    ) external onlyOwner {
        _domainMap[_hyperlaneDomain] = Domain({
            hyperlane: _hyperlaneDomain,
            lzEid: _lzEid,
            dstVault: _dstVault,
            adapterParams: _adapterParams
        });
    }

    function quoteTransferRemote(
        uint32 /*destinationDomain*/,
        bytes32 /*recipient*/,
        uint256 amountOut
    ) external view override returns (Quote[] memory quotes) {
        // Provide a best-effort quote shape: native token fee left to caller to estimate off-chain
        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({token: oftToken, amount: amountOut});
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32) {
        // Destination config
        Domain memory d = _domainMap[destinationDomain];
        require(d.hyperlane == destinationDomain, "EID not configured");
        require(recipient != bytes32(0), "invalid recipient");

        // Send from the calling router (msg.sender) to the destination router vault via OFT
        IOFTCore(oftToken).sendFrom{value: msg.value}(
            msg.sender,
            d.lzEid,
            d.dstVault,
            amountOut,
            d.adapterParams
        );
        return keccak256(abi.encodePacked(msg.sender, destinationDomain, recipient, amountOut, block.number));
    }
}



