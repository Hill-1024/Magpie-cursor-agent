#!/bin/bash
set -eu
bridge_source="$(cd -- "$(dirname -- "$0")" && pwd)"
case "${1:-setup}" in
  --help|-h) echo 'Usage: bash setup.command [setup|status|uninstall|--version]'; exit 0 ;;
esac
bridge_bun_root="${XDG_CACHE_HOME:-$HOME/.cache}/magpie/bun"
bridge_runtime="${MAGPIE_BUN:-}"
if [ -z "$bridge_runtime" ] && [ -x "$bridge_source/bin/runtime" ]; then
  bridge_runtime="$bridge_source/bin/runtime"
fi
if [ -z "$bridge_runtime" ]; then
  for bridge_candidate in "$bridge_bun_root"/*/magpie-bun; do
    if [ -x "$bridge_candidate" ]; then
      bridge_runtime="$bridge_candidate"
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
if [ -z "${MAGPIE_BUN:-}" ] && [ -d "$bridge_bun_root" ] && [ "$bridge_runtime" != "$bridge_source/bin/runtime" ] && [[ "$bridge_runtime" == *magpie-bun ]]; then
  bridge_runtime="$("$bridge_runtime" -e 'const fs=require("fs"),p=require("path");let result=process.execPath;try{const root=process.argv[1],v=JSON.parse(fs.readFileSync(p.join(root,"state.json"))).current;if(/^\d+\.\d+\.\d+$/.test(v)){const candidate=p.join(root,v,"magpie-bun");fs.accessSync(candidate,fs.constants.X_OK);result=candidate}}catch{}console.log(result)' "$bridge_bun_root")"
fi
exec "$bridge_runtime" "$bridge_source/install.js" "$@"
