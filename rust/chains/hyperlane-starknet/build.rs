use cainome::rs::abigen;

fn main() {
    abigen!(
        Mailbox,
        "abis/Mailbox.contract_class.json",
         type_aliases {
            openzeppelin::access::ownable::ownable::OwnableComponent::Event as OwnableCptEvent;
            openzeppelin::upgrades::upgradeable::UpgradeableComponent::Event as UpgradeableCptEvent;
         },
        output_path("src/bindings.rs")
    );
}
