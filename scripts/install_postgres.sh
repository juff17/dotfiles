#!/usr/bin/env bash
set -e

echo "==> Installing PostgreSQL (server + client)"

# Add PGDG repo key
wget -qO - https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/postgresql.gpg

# Add repo
echo \
"deb [signed-by=/usr/share/keyrings/postgresql.gpg] \
http://apt.postgresql.org/pub/repos/apt \
$(lsb_release -cs)-pgdg main" \
| sudo tee /etc/apt/sources.list.d/pgdg.list

sudo apt update

# Install PostgreSQL 16 server + client + contrib tools
sudo apt install -y postgresql-16 postgresql-client-16 postgresql-contrib

echo "==> PostgreSQL installed"
