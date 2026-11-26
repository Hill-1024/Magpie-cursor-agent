#!/bin/bash
set -eu
bridge_source="$(cd -- "$(dirname -- "$0")" && pwd)"
case "${1:-setup}" in
  --help|-h) echo 'Usage: bash setup.command [setup|status|uninstall|--version]'; exit 0 ;;
esac
bridge_runtime="${MAGPIE_BUN:-}"
if [ -z "$bridge_runtime" ] && [ -x "$bridge_source/bin/runtime" ]; then
  bridge_runtime="$bridge_source/bin/runtime"
fi
if [ -z "$bridge_runtime" ]; then
  for bridge_bun_root in "$HOME/Desktop/data/cache/bun" "${XDG_CACHE_HOME:-$HOME/.cache}/magpie/bun" "$HOME/.cache/magpie/bun"; do
    [ -d "$bridge_bun_root" ] || continue
    bridge_first_bun=""
    for bridge_candidate in "$bridge_bun_root"/*/magpie-bun; do
      if [ -x "$bridge_candidate" ]; then
        bridge_first_bun="$bridge_candidate"
        break
      fi
    done
    [ -n "$bridge_first_bun" ] || continue
    bridge_selected="$("$bridge_first_bun" -e 'const fs=require("fs"),p=require("path");const root=process.argv[1];const parse=v=>{const m=/^(\d+)\.(\d+)\.(\d+)/.exec(v);return m?[+m[1],+m[2],+m[3]]:null};const cmp=(a,b)=>{for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0};let best=null;for(const d of fs.readdirSync(root,{withFileTypes:true})){if(!d.isDirectory())continue;const ver=parse(d.name);if(!ver)continue;const c=p.join(root,d.name,"magpie-bun");try{fs.accessSync(c,fs.constants.X_OK);if(!best||cmp(ver,best.ver)>0)best={ver,c}}catch{}}if(best)console.log(best.c)' "$bridge_bun_root" 2>/dev/null || true)"
    if [ -n "$bridge_selected" ] && [ -x "$bridge_selected" ]; then
      bridge_runtime="$bridge_selected"
      break
    fi
  done
fi
if [ -z "$bridge_runtime" ] && command -v node >/dev/null 2>&1; then
  bridge_runtime="$(command -v node)"
fi
if [ -z "$bridge_runtime" ] || [ ! -x "$bridge_runtime" ]; then
  echo '找不到可用运行时（Magpie Bun 或 Node.js）。请先安装 Magpie 或 Node.js，或通过 MAGPIE_BUN 指定运行时。' >&2
  exit 1
fi
exec "$bridge_runtime" "$bridge_source/install.js" "$@"
