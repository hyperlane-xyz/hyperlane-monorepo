use clap::{arg, command, Command};
use ethers::signers::{LocalWallet, Signer};
use gelato::chains::Chain;
use gelato::forward_request::op::{Op, OpArgs, Options, PaymentType};
use gelato::task_status_call::{TaskStatusCall, TaskStatusCallArgs};
use reqwest::Client;
use std::sync::Arc;

// TODO(webbhorn): move into an abacus CLI subcommand once it is migrated to
// Clap from structopt.

// TODO(webbhorn): Switch to using typed derive
// https://github.com/clap-rs/clap/blob/master/examples/typed-derive.rs.

#[tokio::main]
async fn main() {
    let matches = command!()
        .subcommand(
            Command::new("task-status")
                .alias("stat")
                .about("Polls for status of an existing Gelato task")
                .arg(arg!(<TASK_ID>)),
        )
        .subcommand(
            Command::new("forward-request")
                .alias("fwd")
                .about("Runs a ForwardRequest op against Gelato Relay")
                .arg(arg!(-c - -chain[chain]).default_value("5"))
                .arg(
                    arg!(-t - -target_contract_address[target])
                        .default_value("0x8580995EB790a3002A55d249e92A8B6e5d0b384a"),
                )
                .arg(arg!(-d - -data[data]).default_value(
                    "0x4b327067000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee",
                ))
                .arg(
                    arg!(-f - -fee_token[fee_token])
                        .default_value("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"),
                )
                .arg(arg!(-p - -payment_type[payment_type]).default_value("1"))
                .arg(arg!(-m - -max_fee[max_fee]).default_value("1000000000000000000"))
                .arg(arg!(-g - -gas[gas]).default_value("200000"))
                .arg(
                    arg!(-s - -sponsor[sponsor])
                        .default_value("0xEED5eA7e25257a272cb3bF37B6169156D37FB908"),
                )
                .arg(arg!(-S - -sponsor_chain_id[sponsor_chain_id]).default_value("5"))
                .arg(arg!(-k - -private_key[private_key]).default_value(
                    "969e81320ae43e23660804b78647bd4de6a12b82e3b06873f11ddbe164ebf58b",
                ))
                .arg(arg!(-n - -nonce[nonce]).default_value("0"))
                .arg(
                    arg!(-e - -enforce_sponsor_nonce[enforce_sponsor_nonce]).default_value("false"),
                )
                .arg(
                    arg!(-o - -enforce_sponsor_nonce_ordering[enforce_sponsor_nonce_ordering])
                        .default_value("false"),
                ),
        )
        .get_matches();

    match matches.subcommand() {
        Some(("task-status", sub_matches)) => {
            let id: String = sub_matches.value_of("TASK_ID").unwrap().parse().unwrap();
            let call: TaskStatusCall = TaskStatusCall {
                http: Arc::new(Client::new()),
                args: TaskStatusCallArgs {
                    task_id: id.clone(),
                },
            };
            let result = call.run().await.unwrap();
            println!("Task status for task_id='{}':\n{:?}", &id, &result);
        }
        Some(("forward-request", sub_matches)) => {
            let args = OpArgs {
                chain_id: Chain::Goerli, // TODO: figure out parsing...
                target: sub_matches
                    .value_of("target_contract_address")
                    .unwrap()
                    .parse()
                    .unwrap(),
                data: sub_matches.value_of("data").unwrap().parse().unwrap(),
                fee_token: sub_matches.value_of("fee_token").unwrap().parse().unwrap(),
                payment_type: PaymentType::AsyncGasTank, // TODO: figure out parsing...
                max_fee: sub_matches.value_of("max_fee").unwrap().parse().unwrap(),
                gas: sub_matches.value_of("gas").unwrap().parse().unwrap(),
                sponsor: sub_matches.value_of("sponsor").unwrap().parse().unwrap(),
                sponsor_chain_id: Chain::Goerli,
                nonce: sub_matches.value_of("nonce").unwrap().parse().unwrap(),
                enforce_sponsor_nonce: sub_matches
                    .value_of("enforce_sponsor_nonce")
                    .unwrap()
                    .parse()
                    .unwrap(),
                enforce_sponsor_nonce_ordering: sub_matches
                    .value_of("enforce_sponsor_nonce_ordering")
                    .unwrap()
                    .parse()
                    .unwrap(),
            };
            dbg!(&args);
            let wallet = sub_matches
                .value_of("private_key")
                .unwrap()
                .parse::<LocalWallet>()
                .unwrap();
            dbg!(&wallet);
            let sig = wallet.sign_typed_data(&args).await.unwrap();
            println!("{}", &sig);
            let http = reqwest::Client::new();
            let op = Op {
                args,
                opts: Options::default(),
                signer: wallet,
                http: Arc::new(http),
            };
            let result = op.run().await.expect("forward request op");
            println!("{:?}", &result);
        }
        _ => unreachable!("Exhausted list of subcommands and subcommand_required prevents `None`"),
    }
}
