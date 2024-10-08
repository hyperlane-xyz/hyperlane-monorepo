provider "aws" {
  region = var.aws_region  # Set the AWS region for the provider
}

resource "aws_ecs_cluster" "validator_cluster" {
  name = "hyperlane-validator-cluster"  # Name of the ECS cluster for the validator
}

resource "aws_vpc" "validator_vpc" {
  cidr_block           = "10.0.0.0/16"  # Define the IP range for the VPC
  enable_dns_support   = true           # Enable DNS support in the VPC
  enable_dns_hostnames = true           # Enable DNS hostnames in the VPC
}

data "aws_availability_zones" "available" {}  # Fetch the list of available AZs

resource "aws_subnet" "public_subnet" {
  vpc_id                  = aws_vpc.validator_vpc.id  # Associate with the VPC
  cidr_block              = "10.0.2.0/24"             # Define the IP range for the public subnet
  availability_zone       = data.aws_availability_zones.available.names[0]  # Use the first available AZ
  map_public_ip_on_launch = true  # Automatically assign public IP on instance launch
}

resource "aws_subnet" "validator_subnet" {
  vpc_id                  = aws_vpc.validator_vpc.id  # Associate with the VPC
  cidr_block              = "10.0.1.0/24"             # Define the IP range for the validator subnet
  availability_zone       = data.aws_availability_zones.available.names[0]  # Use the first available AZ
  map_public_ip_on_launch = false  # Do not assign public IP on instance launch
}

resource "aws_internet_gateway" "vpc_igw" {
  vpc_id = aws_vpc.validator_vpc.id  # Attach the internet gateway to the VPC
}

resource "aws_eip" "nat_gateway_eip" {
  domain = "vpc"  # Allocate an Elastic IP in the VPC domain
}

resource "aws_nat_gateway" "validator_nat_gateway" {
  allocation_id = aws_eip.nat_gateway_eip.id  # Associate the EIP with the NAT gateway
  subnet_id     = aws_subnet.public_subnet.id  # Place the NAT gateway in the public subnet
  depends_on    = [aws_internet_gateway.vpc_igw]  # Ensure IGW is created before the NAT gateway
}

resource "aws_route_table" "public_route_table" {
  vpc_id = aws_vpc.validator_vpc.id  # Associate the route table with the VPC

  route {
    cidr_block = "0.0.0.0/0"  # Route all traffic
    gateway_id = aws_internet_gateway.vpc_igw.id  # Through the internet gateway
  }
}

resource "aws_route_table" "private_route_table" {
  vpc_id = aws_vpc.validator_vpc.id  # Associate the route table with the VPC

  route {
    cidr_block     = "0.0.0.0/0"  # Route all traffic
    nat_gateway_id = aws_nat_gateway.validator_nat_gateway.id  # Through the NAT gateway
  }
}

resource "aws_route_table_association" "public_subnet_association" {
  subnet_id      = aws_subnet.public_subnet.id  # Associate the public subnet
  route_table_id = aws_route_table.public_route_table.id  # With the public route table
}

resource "aws_route_table_association" "private_subnet_association" {
  subnet_id      = aws_subnet.validator_subnet.id  # Associate the validator subnet
  route_table_id = aws_route_table.private_route_table.id  # With the private route table
}

resource "aws_security_group" "validator_sg" {
  name        = "validator-sg"  # Name of the security group for the validator
  vpc_id      = aws_vpc.validator_vpc.id  # Associate with the VPC

  # prometheus
  ingress {
    from_port   = 9090  # Prometheus metrics port
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # Allow traffic from any IP
  }

  # efs mounting
  ingress {
    from_port   = 2049  # NFS port for EFS
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = [aws_subnet.validator_subnet.cidr_block]  # Allow traffic from the validator subnet
  }

  # all egress
  egress {
    from_port   = 0  # Allow all outbound traffic
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]  # To any IP
  }
}
