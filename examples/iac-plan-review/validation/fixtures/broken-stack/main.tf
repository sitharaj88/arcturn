# PLAN-UNAVAILABLE fixture.
#
# `tofu init` fails here on purpose: the module source below names a directory
# that does not exist. There is no plan to review after this failure, and the
# agent's refusal has to have a real trigger before the pack is allowed to
# claim it does.

terraform {
  required_version = ">= 1.0"
}

module "vpc" {
  source = "./modules/network"

  cidr_block = "10.0.0.0/16"
}
