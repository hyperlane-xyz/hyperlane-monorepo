use crate::component::Component;
use crate::utils::AgentHandles;

#[derive(Default)]
pub struct Anvil {}

impl Component for Anvil {
    fn build(&mut self) {
        // we assume anvil is ready to go for now
    }

    fn run(self: Box<Self>) -> Vec<AgentHandles> {
        todo!()
    }
}
