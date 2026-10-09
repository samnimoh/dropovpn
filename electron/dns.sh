#!/bin/sh
# Per-tunnel resolver: no edits to Wi-Fi/Ethernet preferences or resolv.conf.
set -eu
case "${dev:-}" in ''|*[!a-zA-Z0-9]*) exit 1 ;; esac
key="State:/Network/Service/DropoVPN-${dev}/DNS"
if [ "${script_type:-}" = down ]; then
  /usr/sbin/scutil <<EOF
remove $key
quit
EOF
  /bin/rm -f dns-device
else
  servers=$(/usr/bin/env | /usr/bin/awk -F= '/^foreign_option_[0-9]+=/ { if ($2 ~ /^dhcp-option DNS /) { split($2,a," "); if(a[3] ~ /^[0-9a-fA-F:.]+$/) printf "%s ",a[3]; } }')
  [ -n "$servers" ] || exit 0
  printf '%s' "$dev" > dns-device
  /usr/sbin/scutil <<EOF
d.init
d.add ServerAddresses * $servers
d.add InterfaceName $dev
d.add SupplementalMatchDomains * ""
d.add SupplementalMatchOrders * 0
d.add SupplementalMatchDomainsNoSearch # 1
set $key
quit
EOF
fi
/usr/bin/dscacheutil -flushcache || true
