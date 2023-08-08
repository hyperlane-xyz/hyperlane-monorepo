use crate::{Context, HelloWorldCmd, HelloWorldDeploy, HelloWorldSubCmd};

pub(crate) fn process_helloworld_cmd(mut ctx: Context, cmd: HelloWorldCmd) {
    match cmd.cmd {
        HelloWorldSubCmd::Deploy(deploy) => {
            deploy_helloworld(&mut ctx, deploy);
        }
    }
}

fn deploy_helloworld(_ctx: &mut Context, _deploy: HelloWorldDeploy) {}
