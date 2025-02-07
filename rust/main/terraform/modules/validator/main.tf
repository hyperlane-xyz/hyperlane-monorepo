# Sets up roles, permissions and KMS key
# Replaces https://docs.hyperlane.xyz/docs/operate/set-up-agent-keys
module "iam_kms" {
  source = "../iam_kms"

  aws_region           = var.aws_region
  aws_log_group        = var.aws_log_group
  validator_name       = var.validator_name
  efs_access_point_arn = module.efs.access_point_arn
}

# Creates bucket for posting validator signatures
# Replaces https://docs.hyperlane.xyz/docs/operate/validators/validator-aws
module "s3" {
  source = "../s3"

  validator_name         = var.validator_name
  validator_iam_user_arn = module.iam_kms.ecs_user_arn
}

# Creates file system and mounting point for the validator task
module "efs" {
  source = "../efs"

  creation_token     = "${var.validator_name}-db-fs"
  subnet_id          = var.validator_subnet_id
  security_group_ids = [var.validator_sg_id]
}

# A template for running the validator task
resource "aws_ecs_task_definition" "validator" {
  family                   = var.validator_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.validator_cpu
  memory                   = var.validator_memory
  execution_role_arn       = module.iam_kms.validator_execution_role_arn
  task_role_arn            = module.iam_kms.validator_task_role_arn

  container_definitions = jsonencode([
    {
      name  = "validator",
      image = "gcr.io/abacus-labs-dev/hyperlane-agent:${var.validator_image_version}",
      user  = "1000:1000",
      secrets = [
        {
          name      = "AWS_ACCESS_KEY_ID",
          valueFrom = module.iam_kms.ecs_user_access_key_id_arn
        },
        {
          name      = "AWS_SECRET_ACCESS_KEY",
          valueFrom = module.iam_kms.ecs_user_secret_access_key_arn
        }
      ],
      mountPoints = [
        {
          sourceVolume  = "hyperlane_db",
          containerPath = "/hyperlane_db"
        },
      ],
      portMappings = [
        {
          containerPort = 9090, # Prometheus metrics port
          hostPort      = 9090
        }
      ],
      command = [
        "./validator",
        "--db",
        "/hyperlane_db",
        "--originChainName",
        var.origin_chain_name,
        "--validator.type",
        "aws",
        "--validator.id",
        module.iam_kms.validator_signer_key_alias,
        "--chains.${var.origin_chain_name}.type",
        "aws",
        "--chains.${var.origin_chain_name}.id",
        module.iam_kms.validator_signer_key_alias,
        "--checkpointSyncer.type",
        "s3",
        "--checkpointSyncer.bucket",
        module.s3.validator_bucket_id,
        "--checkpointSyncer.region",
        var.aws_region,
        "--validator.region",
        var.aws_region
      ],
      logConfiguration = {
        logDriver = "awslogs",
        options = {
          "awslogs-group"         = var.aws_log_group,
          "awslogs-region"        = var.aws_region,
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  volume {
    name = "hyperlane_db"

    efs_volume_configuration {
      file_system_id     = module.efs.file_system_id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = module.efs.access_point_id
        iam             = "ENABLED"
      }
    }
  }
}

# An ECS service for running the validator ECS task
resource "aws_ecs_service" "validator_service" {
  name            = var.validator_name
  cluster         = var.validator_cluster_id
  task_definition = aws_ecs_task_definition.validator.arn
  launch_type     = "FARGATE"

  # avoid rolling deployments to not lock agent db
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  network_configuration {
    subnets         = [var.validator_subnet_id]
    security_groups = [var.validator_sg_id]
  }

  desired_count = var.validator_task_disabled ? 0 : 1

  # implicit dependency on nat gateway existing
  tags = {
    NatGatewayID = var.validator_nat_gateway_id
  }
}
