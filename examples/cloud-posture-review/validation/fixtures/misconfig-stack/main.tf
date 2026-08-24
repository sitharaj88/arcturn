# Deliberately misconfigured Terraform. This tree exists so a static scanner has
# something real to flag without a credential. Do not deploy it; do not init it.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# Open SSH from the whole internet.
resource "aws_security_group" "bastion" {
  name        = "posture-fixture-bastion"
  description = "fixture: ssh open to the world"
  vpc_id      = "vpc-0fixture0000000000"

  ingress {
    description = "ssh from anywhere"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "rdp from anywhere"
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# No encryption block, no logging, no versioning, no public-access block.
resource "aws_s3_bucket" "artifacts" {
  bucket = "posture-fixture-artifacts"
}

resource "aws_s3_bucket_acl" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  acl    = "public-read"
}

# Publicly reachable database with no encryption and no backups.
resource "aws_db_instance" "reporting" {
  identifier                 = "posture-fixture-reporting"
  allocated_storage          = 20
  engine                     = "postgres"
  instance_class             = "db.t3.micro"
  username                   = "postgres"
  password                   = "hunter2-fixture-not-a-real-secret"
  publicly_accessible        = true
  storage_encrypted          = false
  backup_retention_period    = 0
  auto_minor_version_upgrade = false
  skip_final_snapshot        = true
}
