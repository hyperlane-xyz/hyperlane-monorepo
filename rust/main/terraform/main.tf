# Configure a Hyperlane Validator
# Replaces https://docs.hyperlane.xyz/docs/operate/validators/run-validators
module "your_validator_name" {
  source = "./modules/validator"

  validator_name    = "your-validator-name"
  origin_chain_name = "originChainName"

  aws_region               = var.aws_region
  validator_cluster_id     = aws_ecs_cluster.validator_cluster.id
  validator_subnet_id      = aws_subnet.validator_subnet.id
  validator_sg_id          = aws_security_group.validator_sg.id
  validator_nat_gateway_id = aws_nat_gateway.validator_nat_gateway.id

  # Disabling the validator task allows you to set up all the required infrastructure
  # without running the actual validator yet. This is useful when setting up a validator for
  # the first time, so that you can find out the validator address and fund it before it
  # performs the announcement transaction.
  # validator_task_disabled = true
}
