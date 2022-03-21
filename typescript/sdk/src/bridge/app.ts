import { hexlify } from '@ethersproject/bytes';
import { BigNumberish, ethers } from 'ethers';
import { BridgeToken, BridgeToken__factory } from '@abacus-network/apps';

import { AbacusApp } from '../app';
import { domains } from '../domains';
import { AbacusCore } from '../core';
import { ChainName, NameOrDomain } from '../types';
import { Address, canonizeId, evmId } from '../utils';

import { BridgeContractAddresses, BridgeContracts } from './contracts';
import { local } from './environments';
import { TransferMessage } from './message';
import { TokenIdentifier, ResolvedTokenInfo } from './tokens';

export class AbacusBridge extends AbacusApp<
  BridgeContractAddresses,
  BridgeContracts
> {
  constructor(addresses: Partial<Record<ChainName, BridgeContractAddresses>>) {
    super();
    for (const chain of Object.keys(addresses) as ChainName[]) {
      this.registerDomain(domains[chain])
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new BridgeContracts(addresses[chain]!));
    }
  }

  /**
   * Resolve the local representation of a token on some domain. E.g. find the
   * deployed Celo address of Ethereum's Sushi Token.
   *
   * WARNING: do not hold references to this contract, as it will not be
   * reconnected in the event the chain connection changes.
   *
   * @param nameOrDomain the target domain, which hosts the representation
   * @param token The token to locate on that domain
   * @returns An interface for that token (if it has been deployed on that
   * domain)
   */
  async resolveRepresentation(
    nameOrDomain: NameOrDomain,
    token: TokenIdentifier,
  ): Promise<BridgeToken | undefined> {
    const bridge = this.mustGetContracts(nameOrDomain);

    const tokenId = canonizeId(token.id);

    const address = await bridge.router['getLocalAddress(uint32,bytes32)'](
      token.domain,
      tokenId,
    );

    if (!address) {
      return;
    }

    let contract = new BridgeToken__factory().attach(evmId(address));

    const connection = this.getConnection(nameOrDomain);
    if (connection) {
      contract = contract.connect(connection);
    }
    return contract;
  }

  /**
   * Resolve the local representation of a token on ALL known domain. E.g.
   * find ALL deployed addresses of Ethereum's Sushi Token, on all registered
   * domains.
   *
   * WARNING: do not hold references to these contracts, as they will not be
   * reconnected in the event the chain connection changes.
   *
   * @param token The token to locate on ALL domains
   * @returns A {@link ResolvedTokenInfo} object with representation addresses
   */
  async resolveRepresentations(
    token: TokenIdentifier,
  ): Promise<ResolvedTokenInfo> {
    const tokens: Map<number, BridgeToken> = new Map();

    await Promise.all(
      this.domainNumbers.map(async (domain) => {
        const tok = await this.resolveRepresentation(domain, token);
        if (tok) {
          tokens.set(domain, tok);
        }
      }),
    );

    return {
      domain: this.resolveDomain(token.domain),
      id: token.id,
      tokens,
    };
  }

  /**
   * Resolve the canonical domain and identifier for a representation on some
   * domain.
   *
   * @param nameOrDomain The domain hosting the representation
   * @param representation The address of the representation on that domain
   * @returns The domain and ID for the canonical token
   * @throws If the token is unknown to the bridge router on its domain.
   */
  async resolveCanonicalIdentifier(
    nameOrDomain: NameOrDomain,
    representation: Address,
  ): Promise<TokenIdentifier> {
    const domain = this.resolveDomain(nameOrDomain);
    const bridge = this.mustGetContracts(nameOrDomain);
    const repr = hexlify(canonizeId(representation));

    const canonical = await bridge.router.representationToCanonical(
      representation,
    );

    if (canonical[0] !== 0) {
      return {
        domain: canonical[0],
        id: canonical[1],
      };
    }

    // check if it's a local token
    const local = await bridge.router['getLocalAddress(uint32,bytes32)'](
      domain,
      repr,
    );
    if (local !== ethers.constants.AddressZero) {
      return {
        domain,
        id: hexlify(canonizeId(local)),
      };
    }

    // throw
    throw new Error('Token not known to the bridge');
  }

  /**
   * Resolve an interface for the canonical token corresponding to a
   * representation on some domain.
   *
   * @param nameOrDomain The domain hosting the representation
   * @param representation The address of the representation on that domain
   * @returns An interface for that token
   * @throws If the token is unknown to the bridge router on its domain.
   */
  async resolveCanonicalToken(
    nameOrDomain: NameOrDomain,
    representation: Address,
  ): Promise<BridgeToken> {
    const canonicalId = await this.resolveCanonicalIdentifier(
      nameOrDomain,
      representation,
    );
    if (!canonicalId) {
      throw new Error('Token seems to not exist');
    }
    const token = await this.resolveRepresentation(
      canonicalId.domain,
      canonicalId,
    );
    if (!token) {
      throw new Error(
        'Cannot resolve canonical on its own domain. how did this happen?',
      );
    }
    return token;
  }

  /**
   * Send tokens from one domain to another. Approves the bridge if necessary.
   *
   * @param from The domain to send from
   * @param to The domain to send to
   * @param token The token to send
   * @param amount The amount (in smallest unit) to send
   * @param recipient The identifier to send to on the `to` domain
   * @param overrides Any tx overrides (e.g. gas price)
   * @returns a {@link TransferMessage} object representing the in-flight
   *          transfer
   * @throws On missing signers, missing tokens, tx issues, etc.
   */
  async send(
    core: AbacusCore,
    from: NameOrDomain,
    to: NameOrDomain,
    token: TokenIdentifier,
    amount: BigNumberish,
    recipient: Address,
    overrides: ethers.Overrides = {},
  ): Promise<TransferMessage> {
    const fromBridge = this.mustGetContracts(from);
    const bridgeAddress = fromBridge.router.address;

    const fromToken = await this.resolveRepresentation(from, token);
    if (!fromToken) {
      throw new Error(`Token not available on ${from}`);
    }
    const sender = this.getSigner(from);
    if (!sender) {
      throw new Error(`No signer for ${from}`);
    }
    const senderAddress = await sender.getAddress();

    const approved = await fromToken.allowance(senderAddress, bridgeAddress);
    // Approve if necessary
    if (approved.lt(amount)) {
      const tx = await fromToken.approve(bridgeAddress, amount, overrides);
      await tx.wait();
    }

    const tx = await fromBridge.router.send(
      fromToken.address,
      amount,
      this.resolveDomain(to),
      canonizeId(recipient),
      overrides,
    );
    const receipt = await tx.wait();

    const message = TransferMessage.singleFromReceipt(core, from, receipt);
    if (!message) {
      throw new Error();
    }

    return message as TransferMessage;
  }

  /**
   * Send a chain's native asset from one chain to another using the
   * `EthHelper` contract.
   *
   * @param from The domain to send from
   * @param to The domain to send to
   * @param amount The amount (in smallest unit) to send
   * @param recipient The identifier to send to on the `to` domain
   * @param overrides Any tx overrides (e.g. gas price)
   * @returns a {@link TransferMessage} object representing the in-flight
   *          transfer
   * @throws On missing signers, tx issues, etc.
   */
  async sendNative(
    core: AbacusCore,
    from: NameOrDomain,
    to: NameOrDomain,
    amount: BigNumberish,
    recipient: Address,
    overrides: ethers.PayableOverrides = {},
  ): Promise<TransferMessage> {
    const ethHelper = this.mustGetContracts(from).helper;
    if (!ethHelper) {
      throw new Error(`No ethHelper for ${from}`);
    }

    const toDomain = this.resolveDomain(to);

    overrides.value = amount;

    const tx = await ethHelper.sendToEVMLike(toDomain, recipient, overrides);
    const receipt = await tx.wait();

    const message = TransferMessage.singleFromReceipt(core, from, receipt);
    if (!message) {
      throw new Error();
    }

    return message as TransferMessage;
  }
}

export const localBridge = new AbacusBridge(local);
