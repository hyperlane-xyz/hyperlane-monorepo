// use std::process::Command;

// pub async fn deploy_all_contracts() -> Vec<String> {
//     let output = Command::new("node")
//         .arg("./scripts/deploy.js")
//         .output()
//         .expect("Failed to execute deploy script");
//
//     let deployed_contracts: Vec<String> = String::from_utf8(output.stdout)
//         .unwrap()
//         .lines()
//         .map(|line| line.to_string())
//         .collect();
//
//     deployed_contracts
// }
//
// pub fn send_message(contract: &str, message: &str) {
//     let output = Command::new("node")
//         .arg("./scripts/sendMessage.js")
//         .arg(contract)
//         .arg(message)
//         .output()
//         .expect("Failed to execute message script");
//
//     println!("Message sent: {:?}", output);
// }
