# Fixture stack for iac-plan-review validation.
#
# It uses only hashicorp/null, hashicorp/local and hashicorp/random: no cloud
# provider, no credential, no remote backend, no state lock. Everything it
# creates lives under out/ in this directory. It exists so the pack's plan JSON
# contract can be exercised against a plan that was really produced, rather
# than against one written by hand.

terraform {
  required_version = ">= 1.0"
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

resource "random_pet" "stack_name" {
  length    = 2
  separator = "-"
}

resource "local_file" "inventory" {
  filename        = "${path.module}/out/inventory.txt"
  content         = "stack=${random_pet.stack_name.id}\n"
  file_permission = "0644"
}

resource "null_resource" "bootstrap" {
  triggers = {
    inventory = local_file.inventory.content
  }
}

module "greeting" {
  source     = "./modules/greeting"
  stack_name = random_pet.stack_name.id
}

output "stack_name" {
  value = random_pet.stack_name.id
}
