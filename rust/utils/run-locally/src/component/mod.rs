use std::thread::spawn;
use crate::utils::{AgentHandles, TaskHandle};

pub trait Component: Send + 'static {
    // /// Do anything required to get ready for the build step.
    // fn prepare() -> AssertJoinHandle<()>;

    fn build(&mut self);

    // /// Get things ready to run
    // fn build(mut self: Box<Self>) -> TaskHandle<Box<dyn Component>> {
    //     TaskHandle(spawn(move || {
    //         self.build_inner();
    //         self as Box<dyn Component>
    //     }))
    // }

    fn run(self: Box<Self>) -> Vec<AgentHandles>;

    // /// Start the infra and init it, once started and initialized the join handle will
    // /// resolve to the long-running-task handles.
    // fn run(self: Box<Self>) -> TaskHandle<Vec<AgentHandles>> {
    //     TaskHandle(spawn(move || self.run_inner()))
    // }
}

pub fn build_component<C: Component>(mut component: Box<C>) -> TaskHandle<Box<C>> {
    TaskHandle(spawn(move || {
        component.build();
        component
    }))
}

pub fn run_component<C: Component>(component: Box<C>) -> TaskHandle<Vec<AgentHandles>> {
    TaskHandle(spawn(move || component.run()))
}

// pub trait Component: Send + 'static {
//     /// Get things ready to run
//     fn build(self: Box<Self>) -> TaskHandle<Box<dyn Component>>;
//
//     /// Start the infra and init it, once started and initialized the join handle will
//     /// resolve to the long-running-task handles.
//     fn run(self: Box<Self>) -> TaskHandle<Vec<AgentHandles>>;
// }

pub struct Agents {}

impl Component for Agents {
    fn build_inner(&mut self) {
        todo!()
    }

    fn run_inner(self: Box<Self>) -> Vec<AgentHandles> {
        todo!()
    }
}


mod anvil;
use anvil::*;

pub struct Ethereum {
    node: Option<Box<dyn Component>>,
}

impl Component for Ethereum {
    fn build_inner(&mut self) {
        // build sdk

        // start eth node
        let node_task = build_component(Anvil::default());

        self.node = Some(node_task.join());
    }

    fn run_inner(mut self: Box<Self>) -> Vec<AgentHandles> {
        // start eth node
        let node_start_task = self.node.take().unwrap().run();

        // deploy contracts

        node_start_task.join()
    }
}
