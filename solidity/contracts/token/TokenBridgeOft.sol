// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {IOFTV2} from "./interfaces/IOFTV2.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {ValueTransferBridge} from "./interfaces/ValueTransferBridge.sol";

contract TokenBridgeOft is HypERC20Collateral {
    struct Domain {
        uint32 hyperlane;
        uint16 lzEid;
        bytes dstVault;
        bytes adapterParams;
    }

    mapping(uint32 => Domain) internal _domainMap;

    event DomainAdded(uint32 indexed hyperlaneDomain, uint16 lzEid);

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override initializer {
        HypERC20Collateral.initialize(_hook, _interchainSecurityModule, _owner);
    }

    function addDomain(
        uint32 _hyperlaneDomain,
        uint16 _lzEid,
        bytes calldata _dstVault,
        bytes calldata _adapterParams
    ) public onlyOwner {
        _domainMap[_hyperlaneDomain] = Domain({
            hyperlane: _hyperlaneDomain,
            lzEid: _lzEid,
            dstVault: _dstVault,
            adapterParams: _adapterParams
        });
        emit DomainAdded(_hyperlaneDomain, _lzEid);
    }

    function addDomains(Domain[] calldata domains) external onlyOwner {
        for (uint256 i = 0; i < domains.length; i++) {
            addDomain(
                domains[i].hyperlane,
                domains[i].lzEid,
                domains[i].dstVault,
                domains[i].adapterParams
            );
        }
    }

    function hyperlaneDomainToLayerZeroEid(
        uint32 _hyperlaneDomain
    ) public view returns (uint16) {
        Domain memory d = _domainMap[_hyperlaneDomain];
        require(d.hyperlane == _hyperlaneDomain, "LZ EID not configured");
        return d.lzEid;
    }

    function quoteTransferRemote(
        uint32 _destinationDomain,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](2);
        
        // Quote LayerZero V2 fees instead of Hyperlane fees
        Domain memory d = _domainMap[_destinationDomain];
        if (d.hyperlane == _destinationDomain && d.dstVault.length == 32) {
            // Convert dstVault to bytes32 for the quote
            bytes memory vault = d.dstVault;
            bytes32 dstVaultBytes32;
            assembly {
                dstVaultBytes32 := mload(add(vault, 32))
            }
            
            // Build send parameters for quoting
            IOFTV2.SendParam memory sendParam = IOFTV2.SendParam({
                dstEid: uint32(d.lzEid),
                to: dstVaultBytes32,
                amountLD: _amount,
                minAmountLD: _amount,
                extraOptions: d.adapterParams,
                composeMsg: bytes(""),
                oftCmd: bytes("")
            });
            
            try IOFTV2(address(wrappedToken)).quoteSend(sendParam, false) returns (
                IOFTV2.MessagingFee memory fee
            ) {
                quotes[0] = Quote({
                    token: address(0),
                    amount: fee.nativeFee
                });
            } catch {
                // Fallback to a reasonable default fee if quote fails
                quotes[0] = Quote({
                    token: address(0),
                    amount: 0.01 ether
                });
            }
        } else {
            // No domain configured, return minimal fee
            quotes[0] = Quote({
                token: address(0),
                amount: 0.01 ether
            });
        }
        
        quotes[1] = Quote({token: address(wrappedToken), amount: _amount});
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal override returns (bytes32 messageId) {
        bytes32 enrolledRouter = _mustHaveRemoteRouter(_destination);
        require(_recipient == enrolledRouter, "Invalid recipient");

        // Always pull tokens from sender (user or bridge adapter)
        HypERC20Collateral._transferFromSender(_amount);

        uint256 outbound = _outboundAmount(_amount);
        
        // For OFT rebalancing, we only use LayerZero, not Hyperlane messaging
        // So we skip the Hyperlane dispatch and only do the LayerZero send
        Domain memory d = _domainMap[_destination];
        require(d.hyperlane == _destination, "EID not configured");

        // Build LayerZero V2 send parameters
        // Convert dstVault from bytes to bytes32
        bytes memory vault = d.dstVault;
        bytes32 dstVaultBytes32;
        require(vault.length == 32, "Invalid dstVault length");
        assembly {
            dstVaultBytes32 := mload(add(vault, 32))
        }
        
        IOFTV2.SendParam memory sendParam = IOFTV2.SendParam({
            dstEid: uint32(d.lzEid),
            to: dstVaultBytes32,  // Destination router address as bytes32
            amountLD: outbound,
            minAmountLD: outbound,  // No slippage for router-to-router
            extraOptions: d.adapterParams,
            composeMsg: bytes(""),
            oftCmd: bytes("")
        });

        // Use the entire msg.value for LayerZero fees (no Hyperlane protocol fee needed)
        IOFTV2.MessagingFee memory fee = IOFTV2.MessagingFee({
            nativeFee: msg.value,
            lzTokenFee: 0
        });

        // First reset approval to 0 to avoid SafeERC20 error
        wrappedToken.approve(address(wrappedToken), 0);
        // Then approve the exact amount needed
        wrappedToken.approve(address(wrappedToken), outbound);
        
        // Send via LayerZero V2
        messageId = IOFTV2(address(wrappedToken)).send{value: msg.value}(
            sendParam,
            fee,
            address(this)  // Refund address
        );

        emit SentTransferRemote(_destination, _recipient, outbound);
    }

    function _transferTo(address, uint256, bytes calldata) internal override {}
}
