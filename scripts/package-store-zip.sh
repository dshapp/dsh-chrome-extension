#!/usr/bin/env bash
# 把解压版扩展打成可上传 Chrome Web Store 的 zip 包,并自动校验包内容。
#
# 本项目没有构建步骤:zip 里的内容就是工作区里的 runtime 文件原样打包。
# CWS 要求 manifest.json 位于 zip 根目录,所以从仓库根目录压缩,并排除
# node_modules / tests / npm 元数据 / 点文件等开发文件。
#
# 用法:npm run package:zip   (即 bash scripts/package-store-zip.sh)
#
# 发布清单(脚本之外的人工步骤):
#   1. 先改 manifest.json 的 "version"(CWS 拒绝重复版本号),本脚本自动取它命名 zip
#   2. 跑本脚本,把 dist/dsh-chrome-extension-v<version>.zip 传到
#      Chrome Web Store 开发者信息中心(chrome.google.com/webstore/devconsole)
#   3. 商店素材(截图/宣传图/商店图标)在信息中心单独上传,不进 zip
#   4. 权限含 debugger / nativeMessaging / <all_urls>,会走人工深度审核,
#      "权限用途说明"需提前写好
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# runtime 顶层资源 = zip 根内容;manifest 或代码新增顶层文件/目录时同步这里
runtime_items=(
  manifest.json
  background.js
  _locales
  content
  icons
  pages
  src
  sw
)

version="$(node -p 'require("./manifest.json").version')"
out="dist/dsh-chrome-extension-v${version}.zip"

mkdir -p dist
rm -f "$out"

# 排除项与下方 manifest_of 的工作区过滤条件保持一致
zip -r -X -q "$out" "${runtime_items[@]}" \
  -x '*.DS_Store' -x '__MACOSX*' -x '*/.git*'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unzip -q "$out" -d "$tmp"

fail() { echo "FAIL: $*" >&2; exit 1; }

# 1) manifest.json 必须在 zip 根目录(等价于"没有多包一层目录")
unzip -Z1 "$out" | grep -qx 'manifest.json' \
  || fail "manifest.json 不在 zip 根目录"

# 2) 包内容与工作区 runtime 文件逐字节一致(即与本机 unpacked 加载的那份一致)。
#    两侧用同一套过滤,忽略 .DS_Store 等被 zip 排除的杂项。
manifest_of() { # $1 = 基目录,输出 "sha256 路径" 清单
  ( cd "$1" && find "${runtime_items[@]}" -type f \
      ! -name '*.DS_Store' ! -name '__MACOSX*' ! -path '*/.git*' \
      -print | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 )
}
diff <(manifest_of ".") <(manifest_of "$tmp") >/dev/null \
  || fail "zip 内容与工作区不一致"

# 3) 无开发文件混入
dev_pattern='(^|/)(node_modules|tests)(/|$)|(^|/)package(-lock)?\.json$|(^|/)\.git(/|$)|\.DS_Store$|(^|/)\.idea(/|$)|(^|/)AGENTS\.md$|(^|/)vitest\.config\.js$'
if unzip -Z1 "$out" | grep -Eq "$dev_pattern"; then
  unzip -Z1 "$out" | grep -E "$dev_pattern" >&2
  fail "zip 混入开发文件"
fi

echo "created : $root/$out ($(du -h "$out" | cut -f1))"
echo "entries : $(unzip -Z1 "$out" | wc -l | tr -d ' ') files"
echo "verified: manifest.json 在 zip 根目录 / 包内容与工作区逐字节一致 / 无开发文件混入"
