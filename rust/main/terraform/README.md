# Terraform Module for Hyperlane Validator

This Terraform module is designed to set up the necessary infrastructure for a Hyperlane validator on AWS. It automates the creation of resources such as ECS clusters, VPCs, subnets, and security groups required for running a validator node.

> **Note:** This module is intended to be an example of running a validator for a core supported network. You may have to modify the validator module to support more advanced configurations. It is recommended to test thoroughly before using in a production environment.

## Quick start

Copy the example variables file and set the validator name and origin chain you want to run:

```sh
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Then initialize and review the AWS resources Terraform will create:

```sh
terraform init
terraform plan
```

If the plan looks correct, run `terraform apply` to create the resources. Use `terraform apply -auto-approve` only in automation or when you have already reviewed the plan.

For first-time setup, you can keep the validator task disabled while creating the supporting AWS resources, then fund the reported validator address before enabling the task:

```hcl
validator_task_disabled = true
```

Uncomment the existing `validator_task_disabled = true` line in the `module "validator"` block in `main.tf`, or add `validator_task_disabled = true` to that block if it is not present. After funding the validator signer, remove the `validator_task_disabled` setting or set it to `false`.

For more information, read the [Deploy with Terraform](https://hyp-v3-docs-git-feat-aws-agent-guide-abacus-works.vercel.app/docs/operate/deploy-with-terraform) documentation.
