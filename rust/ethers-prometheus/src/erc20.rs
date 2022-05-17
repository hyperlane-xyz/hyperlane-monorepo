use ethers::prelude::*;

abigen!(Erc20, "$CARGO_MANIFEST_DIR/abis/erc20.abi.json");

// /// Allows us to look up new information on the fly using the ERC20 specification.
// pub(crate) async fn get_token_info<M: Middleware>(
//     addr: Address,
//     client: Arc<M>,
// ) -> Result<TokenInfo, ContractError<M>> {
//     let token = Erc20::new(addr, client);
//
//     let name = token.name();
//     let symbol = token.symbol();
//     let decimals = token.decimals();
//     let (name, symbol, decimals) = try_join!(name.call(), symbol.call(), decimals.call())?;
//
//     Ok(TokenInfo {
//         name,
//         symbol,
//         decimals,
//     })
// }
