#!/bin/sh
# Installs the home-network-only firewall on the Raspberry Pi and loads it now
# and at every boot. Run on the Pi:
#   curl -fsSL https://raw.githubusercontent.com/sandeepmataridr-bot/portal/main/infra/pi/install-firewall.sh | sudo sh
# Remove: sudo systemctl disable --now home-only-firewall && sudo rm /etc/home-only.nft /etc/systemd/system/home-only-firewall.service
set -eu
base=https://raw.githubusercontent.com/sandeepmataridr-bot/portal/main/infra/pi
command -v nft >/dev/null || apt-get install -y nftables
curl -fsSL "$base/home-only.nft" -o /etc/home-only.nft
curl -fsSL "$base/home-only-firewall.service" -o /etc/systemd/system/home-only-firewall.service
nft -c -f /etc/home-only.nft
systemctl daemon-reload
systemctl enable --now home-only-firewall
systemctl restart home-only-firewall
echo "Firewall active: only the home network can reach the Pi."
nft list table inet home_only >/dev/null && echo "table inet home_only loaded"
