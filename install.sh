#!/usr/bin/env bash
# =============================================================================
# DSH one-shot installer
#
# Brings a machine from "nothing installed" to "the Chrome extension can start
# the dsh server by itself":
#
#   1. node / npm / pnpm            (installed globally when missing)
#   2. dsh + its three plugins      (into the web profile; the two public
#                                    plugins come from registry.npmjs.org,
#                                    the rest from the internal registry)
#   3. the Native Messaging host    (so Chrome can launch dsh web on demand)
#   4. the CodeMax model provider   (minted through Chrome and written to dsh's
#                                    config *before* the server first starts)
#
# It is idempotent: every step probes first and does nothing when the desired
# state already holds, so re-running after a partial failure is safe.
#
# Usage:
#   ./install.sh
#
# The extension id is derived automatically from manifest.json. Advanced users
# may override it with a positional argument or DSH_EXTENSION_ID.
# Environment overrides:
#   DSH_EXTENSION_ID   advanced override for the derived extension id
#   DSH_REGISTRY       registry for internal packages (@orba/*, dsh, pnpm)
#   DSH_PUBLIC_REGISTRY registry for the public plugins (dsh-chrome-control,
#                      dsh-kimi-computer-use); defaults to registry.npmjs.org
#   DSH_HOME           dsh state directory (default ~/.dsh)
#   DSH_WEB_PORT       port the self-test starts dsh web on (default 3080)
#   DSH_SKIP_LLM_KEY   set to 1 to skip acquiring the CodeMax API key
# =============================================================================
set -euo pipefail

# 内部 registry,只用于内部包(@orba/*)和 dsh CLI / pnpm 自身。
REGISTRY="${DSH_REGISTRY:-https://npm-registry.toolsfdg.net/}"
# dsh-chrome-control 与 dsh-kimi-computer-use 是发布在公共 npm 上的包。
# 内部源虽然代理了它们(HTTP 直接拉 packument 能看到 0.1.5/0.1.6/0.1.7),
# 但经内部源解析时 npm 只认到 0.1.5,装 ^0.1.7 直接 ETARGET;pnpm 能过,
# 于是"能不能装上"取决于用的是哪个包管理器。与其依赖这种差异,不如让这
# 两个包固定走官方源 —— 那里 npm 与 pnpm 都能干净解析到 0.1.7 / 0.1.2。
# 它们不受 DSH_REGISTRY 影响,需要改走内网镜像时用 DSH_PUBLIC_REGISTRY。
PUBLIC_REGISTRY="${DSH_PUBLIC_REGISTRY:-https://registry.npmjs.org/}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WEB_PORT="${DSH_WEB_PORT:-3080}"
HOST_NAME="com.dsh.chrome"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_MANIFEST="$SCRIPT_DIR/manifest.json"
NATIVE_HOST_SOURCE="$SCRIPT_DIR/native-host/dsh-native-host.js"

# dsh-chrome-control 0.2.0 is the pure-plugin bridge that rides dsh web's
# own HTTP server (/chrome/ws + /chrome/mcp), which is what this installer and
# the extension are built for.
CHROME_PKG="dsh-chrome-control@^0.2.0"
CHROME_MIN="0.2.0"
KIMI_PKG="dsh-kimi-computer-use"
CODEMAX_PKG="@orba/dsh-codemax-skills"

ALL_PKGS="$CHROME_PKG $KIMI_PKG $CODEMAX_PKG"

RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
if [ -t 1 ]; then
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; BLUE="$(printf '\033[34m')"
  BOLD="$(printf '\033[1m')"; RESET="$(printf '\033[0m')"
fi
step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"; }
ok()   { printf '  %s\xe2\x9c\x93%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  {
  printf '\n  %sInstallation could not be completed.%s\n' "$RED" "$RESET" >&2
  printf '  What happened: %s\n' "$1" >&2
  printf '  What to do next: fix the item above, then run this installer again.\n' >&2
  printf '  Server log: %s/.dsh-chrome/logs/dsh-web.log\n\n' "$HOME" >&2
  exit 1
}

usage() { sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
case "${1:-}" in -h|--help) usage ;; esac

derive_extension_id() {
  [ -f "$EXTENSION_MANIFEST" ] || return 1
  node -e '
    const fs = require("node:fs"), crypto = require("node:crypto");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!manifest.key) process.exit(1);
    const digest = crypto.createHash("sha256")
      .update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
    process.stdout.write([...digest]
      .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join(""));
  ' "$EXTENSION_MANIFEST"
}

EXTENSION_ID="${1:-${DSH_EXTENSION_ID:-}}"
if [ -z "$EXTENSION_ID" ]; then
  EXTENSION_ID="$(derive_extension_id 2>/dev/null || true)"
  DERIVED_ID=1
else
  DERIVED_ID=0
fi
case "$EXTENSION_ID" in
  ''|*[!a-p]*|???????????????????????????????|?????????????????????????????????*)
    die "the extension id is invalid; expected the 32-letter id derived from manifest.json" ;;
esac
ok "extension identity detected automatically: $EXTENSION_ID"

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported OS: $OS (this installer supports macOS and Linux)" ;;
esac

# ---------------------------------------------------------------------------
# 1. node / npm / pnpm
# ---------------------------------------------------------------------------
step "Checking the JavaScript toolchain"

# Every dsh plugin declares engines.node >=22.19, so an older major breaks the
# plugin tree later; check the major up front rather than at boot.
NODE_MAJOR_MIN=22
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node() {
  if [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      warn "installing node via Homebrew"
      brew install node
      return
    fi
    die "node >=v$NODE_MAJOR_MIN is required but Homebrew is not installed. Install Node from https://nodejs.org/en/download and re-run this script."
  fi
  if command -v apt-get >/dev/null 2>&1; then
    warn "installing node via NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    return
  fi
  die "node >=v$NODE_MAJOR_MIN is required. Install Node from https://nodejs.org/en/download and re-run this script."
}

if ! command -v node >/dev/null 2>&1; then
  warn "node not found"
  install_node
elif [ "$(node_major)" -lt "$NODE_MAJOR_MIN" ]; then
  warn "node $(node -v) is older than the required v$NODE_MAJOR_MIN"
  install_node
fi
command -v node >/dev/null 2>&1 || die "node is still unavailable after installation"
[ "$(node_major)" -ge "$NODE_MAJOR_MIN" ] || die "node $(node -v) is too old; need >=v$NODE_MAJOR_MIN"
ok "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is missing (it normally ships with node)"
ok "npm v$(npm -v)"

# npm's global prefix is root-owned on many Linux setups but user-owned under
# Homebrew; only reach for sudo when the prefix is genuinely unwritable.
# 只用来装 pnpm 自己 —— 之后一切都走 pnpm。
npm_global() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || echo /usr/local)"
  if [ -w "$prefix/lib/node_modules" ] 2>/dev/null || [ -w "$prefix" ]; then
    npm install -g "$@"
  else
    warn "$prefix is not writable; using sudo"
    sudo npm install -g "$@"
  fi
}

# 已经有 pnpm 就直接用,不重装(重装反而可能换掉用户自己管理的那份)。
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm v$(pnpm -v) (already installed)"
else
  warn "pnpm not found; installing globally"
  # 优先用官方独立安装脚本:它不碰 ~/.npm 缓存,也不需要写 npm 的全局
  # prefix,能绕开 sudo 污染 ~/.npm/_cacache 后普通用户再装就撞
  # "EEXIST + EACCES rename ... content-v2/..." 的老坑。
  if curl -fsSL https://get.pnpm.io/install.sh | env SHELL="${SHELL:-/bin/bash}" bash - >/dev/null 2>&1; then
    # 装完当前 shell 还看不到,得把它的 bin 目录并进 PATH。
    PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
    [ -d "$PNPM_HOME" ] || PNPM_HOME="$HOME/.local/share/pnpm"
    export PNPM_HOME
    export PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"
  fi
  # 独立脚本没成功(比如外网不通)就退回 npm。
  command -v pnpm >/dev/null 2>&1 || npm_global pnpm --registry "$REGISTRY"
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm is still unavailable after installation"
ok "pnpm v$(pnpm -v)"

# 'pnpm add -g' 会拒绝执行,除非它的全局 bin 目录已经在 PATH 里
# (报 "The configured global bin directory ... is not in PATH")。
# 用户 shell 没配过 PNPM_HOME 时这一步必然失败,所以这里自己算出目录、
# 建好、并塞进本进程的 PATH —— 只影响本次运行,不改用户的 shell 配置。
ensure_pnpm_global_bin() {
  local home bin
  home="${PNPM_HOME:-}"
  if [ -z "$home" ]; then
    home="$HOME/Library/pnpm"
    [ "$OS" = "Linux" ] && home="$HOME/.local/share/pnpm"
  fi
  export PNPM_HOME="$home"
  # pnpm 报的是 "<global-dir>/bin",而 global-bin-dir 未配置时它就等于
  # $PNPM_HOME/bin。两个都建好、都并进 PATH,省得在版本差异上猜。
  bin="$(pnpm config get global-bin-dir 2>/dev/null)"
  case "$bin" in ""|undefined|null) bin="$home/bin" ;; esac
  mkdir -p "$home" "$bin"
  for d in "$bin" "$home"; do
    case ":$PATH:" in
      *":$d:"*) ;;
      *) PATH="$d:$PATH" ;;
    esac
  done
  export PATH
}
ensure_pnpm_global_bin

# ---------------------------------------------------------------------------
# 2. dsh
# ---------------------------------------------------------------------------
step "Installing dsh"
# 无条件重装,不做 "已存在就跳过"。跳过看着省事,实际上把用错布局装出来的
# dsh 永久锁死:早期版本的本脚本没带 --node-linker=hoisted,那样装出来的
# dsh 能跑 --version、能过 --dump-config,却在 boot 时炸成
# "Cannot find package '@deepseek-ai/cordis-plugin-timer'"。只要"存在即跳过",
# 重跑脚本永远修不好它。每次都重装,脚本就成了幂等的修复入口。
#
# 走 pnpm 而不是 npm:pnpm 用自己的 store(~/Library/pnpm/store),
# 不读 ~/.npm/_cacache,因此不受历史上 sudo npm 留下的 root 属主文件影响。
#
# --node-linker=hoisted 是必须的,不是调优。pnpm 默认把每个包隔离在
# store 里各自的目录下,而 dsh 的 cordis loader 是在运行时按名字
# import 上百个 @deepseek-ai/* 插件的。默认布局下这些兄弟包对
# loader 不可见,一 boot 就炸,端口起不来。hoisted 把依赖摊平进全局
# node_modules,行为跟 npm -g 一致,loader 才解析得到。
#
# 先 remove 再 add:pnpm 对"已装但布局不对"的包不会重排布局,
# 光 add 可能原地复用错误的 node-linker 结果。remove 失败无所谓
# (没装过就是没装过),所以吞掉它的退出码。
pnpm remove -g @deepseek-ai/dsh >/dev/null 2>&1 || true
if ! pnpm add -g @deepseek-ai/dsh --registry "$REGISTRY" --node-linker=hoisted; then
  die "failed to install @deepseek-ai/dsh from $REGISTRY."
fi
command -v dsh >/dev/null 2>&1 || die "dsh is still unavailable after installation.
    pnpm installs it into ${PNPM_HOME:-the pnpm home}; if that is not on your
    PATH, run 'pnpm setup' once and open a new terminal."
ok "dsh $(dsh --version 2>/dev/null || echo '(version unknown)')"

# ---------------------------------------------------------------------------
# 3. plugins
# ---------------------------------------------------------------------------
step "Installing plugins into the web profile"
export DSH_HOME

PROFILE_DIR="$DSH_HOME/profiles/web"

# 'dsh plugin add' forwards to pnpm inside the profile directory and then
# reconciles dsh.profile.bundles from the installed state, so a package that
# declares dsh.bundle joins the layer stack on its own. Never hand-edit the
# profile manifest.
#
# 整个 web profile 直接删掉重建,不做增量修补。这里以前是一张"已知过时包"
# 的名单(dsh-chrome / dsh-codemax-skills 等改名前的旧身份),逐个 remove。
# 那种写法只能处理列进名单的情况:任何别的残留 —— 装了一半的依赖树、
# 用错 registry 解析出来的版本、旧 .npmrc —— 都会留下来,并在 boot 时
# 报 "duplicate loader entry id" 或 ERR_MODULE_NOT_FOUND。
# 全删就没有"漏掉哪一种"的问题,而且 profile 里除了这三个插件本身
# 没有用户数据(会话/凭据都在 DSH_HOME 的别处),删了不丢东西。
if [ -d "$PROFILE_DIR" ]; then
  warn "removing existing web profile for a clean reinstall"
  rm -rf "$PROFILE_DIR"
fi

# 三个包来自两个 registry,但不能分两次 add:--registry 是整条命令一个值,
# 而 pnpm 每次 add 都会照着 package.json 重新解析**所有**已声明的依赖。
# 于是"先内部后公共"那种写法会拿公共源去解析 @orba/dsh-codemax-skills,
# 直接 ERR_PNPM_FETCH_404。反过来同理。
#
# 正确做法是把路由写进 profile 的 .npmrc:默认走公共源,@orba scope 走内部源。
# 这样一次 add 就能把三个包各自解析到正确的地方,且后续任何 pnpm 操作
# (升级、重装)都继续遵守同一套路由,不依赖命令行传了什么。
# 首次安装时 profile 目录还不存在('dsh plugin add' 才会创建它),
# 但 .npmrc 必须在 add 之前就位,否则第一次解析仍会走错源。
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/.npmrc" <<EOF
registry=$PUBLIC_REGISTRY
@orba:registry=$REGISTRY
EOF

# shellcheck disable=SC2086
if ! dsh plugin --profile web add $ALL_PKGS; then
  die "plugin installation failed for $ALL_PKGS.
    dsh-chrome-control and dsh-kimi-computer-use come from the public npm
    registry ($PUBLIC_REGISTRY); @orba/* comes from the internal one
    ($REGISTRY). Check network/proxy access to both, or override with
    DSH_PUBLIC_REGISTRY=<url> / DSH_REGISTRY=<url>."
fi

[ -f "$PROFILE_DIR/package.json" ] || die "profile was not created at $PROFILE_DIR"

# Verify each bundle actually resolves. A published patch that still points at
# a pre-rename package installs cleanly and only explodes at boot, so assert
# resolvability here instead of discovering it when the server refuses to start.
# The dsh CLI's real entry point, used to resolve modules the CLI itself bundles.
# npm 装的 dsh 是指向 lib/bin.js 的符号链接,realpath 一步到位。pnpm 装的却是
# 一个 /bin/sh 垫片,realpath 只会停在垫片自己身上 —— 于是
# @deepseek-ai/dsh-mcp-client 解析不到,verify_bundle 把好好的
# dsh-chrome-control 误判成 "bundle patch references unresolvable module(s)"。
# 所以垫片要先把它 exec 的那个 .js 抠出来,再对那个路径取 realpath。
resolve_dsh_entry() {
  local bin target
  bin="$(command -v dsh 2>/dev/null)" || return 0
  [ -n "$bin" ] || return 0
  if head -c2 "$bin" 2>/dev/null | grep -q '#!' && grep -q 'exec .*\.js' "$bin" 2>/dev/null; then
    # 垫片:取第一条 exec 里的 .js 路径,并把 $basedir 展开成垫片所在目录。
    target="$(grep -oE '"[^"]*\.js"' "$bin" 2>/dev/null | head -1 | tr -d '"')"
    if [ -n "$target" ]; then
      target="${target//\$basedir_win/$(dirname "$bin")}"
      target="${target//\$basedir/$(dirname "$bin")}"
      [ -f "$target" ] && bin="$target"
    fi
  fi
  node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$bin" 2>/dev/null || true
}
DSH_CLI_ENTRY="$(resolve_dsh_entry)"
export DSH_CLI_ENTRY

verify_bundle() {
  node "$VERIFY_JS" "$PROFILE_DIR" "$1"
}

VERIFY_JS="$(mktemp -t dsh-verify-XXXXXX).cjs"
trap 'rm -f "$VERIFY_JS"' EXIT
cat > "$VERIFY_JS" <<'DSH_VERIFY_EOF'
const { createRequire } = require("node:module");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const [profileDir, pkg] = process.argv.slice(2);
const req = createRequire(join(profileDir, "noop.js"));
// A patch row may name a module the dsh CLI itself provides (for example
// @deepseek-ai/dsh-mcp-client), which resolves from the CLI's own tree rather
// than the profile's. Try both scopes before calling a name broken.
let coreReq = null;
if (process.env.DSH_CLI_ENTRY) {
  try { coreReq = createRequire(process.env.DSH_CLI_ENTRY); } catch {}
}
function resolvable(name) {
  try { req.resolve(name); return true; } catch {}
  if (coreReq) {
    try { coreReq.resolve(name); return true; } catch {}
  }
  return false;
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(req.resolve(pkg + "/package.json"), "utf8"));
} catch {
  console.error(pkg + ": not installed in the profile");
  process.exit(1);
}
const patchRef = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch;
if (!patchRef) {
  console.error(pkg + ": declares no dsh.bundle.patch, so it is not a profile layer");
  process.exit(1);
}
let patchPath;
try {
  patchPath = req.resolve(pkg + "/" + patchRef.replace(/^\.\//, ""));
} catch {
  console.error(pkg + ": bundle patch " + patchRef + " cannot be resolved");
  process.exit(1);
}
if (!existsSync(patchPath)) {
  console.error(pkg + ": bundle patch missing at " + patchPath);
  process.exit(1);
}
// Every `name:` in the patch is a module specifier the loader will import.
const names = readFileSync(patchPath, "utf8")
  .split("\n")
  .map(function (line) { return line.match(/^\s*(?:-\s*)?name:\s*['"]?([^'"\s#]+)/); })
  .filter(Boolean)
  .map(function (m) { return m[1]; });
const broken = [];
for (const name of new Set(names)) {
  if (!resolvable(name)) broken.push(name);
}
if (broken.length) {
  console.error(pkg + "@" + manifest.version + ": bundle patch references unresolvable module(s): " + broken.join(", "));
  console.error("  This build is broken - its patch names a package that is not installed.");
  process.exit(1);
}
console.log(manifest.version);
DSH_VERIFY_EOF

for pkg in dsh-chrome-control "$KIMI_PKG" "$CODEMAX_PKG"; do
  if version="$(verify_bundle "$pkg")"; then
    ok "$pkg@$version"
  else
    die "$pkg is installed but unusable (see the message above)."
  fi
done

# Guard the version floor explicitly: pnpm may resolve an older cached copy.
CHROME_VERSION="$(verify_bundle dsh-chrome-control)"
if [ "$(printf '%s\n%s\n' "$CHROME_MIN" "$CHROME_VERSION" | sort -V | head -1)" != "$CHROME_MIN" ]; then
  die "dsh-chrome-control $CHROME_VERSION is older than the required pure-plugin bridge version $CHROME_MIN."
fi

# The composed tree is the real proof that the profile boots. --dump-config
# renders the tree without instantiating it, so it happily prints a config the
# loader would reject; check for repeated ids explicitly, because two bundles
# inserting the same id abort boot with "duplicate loader entry id".
COMPOSED="$(dsh --profile web --dump-config 2>&1)" || {
  printf '%s\n' "$COMPOSED" >&2
  die "the composed profile is invalid; see the output above"
}
DUPLICATE_IDS="$(printf '%s\n' "$COMPOSED" | sed -n 's/^- id: //p' | sort | uniq -d)"
if [ -n "$DUPLICATE_IDS" ]; then
  printf '  duplicated ids:\n%s\n' "$DUPLICATE_IDS" >&2
  die "two bundles insert the same row id, which aborts boot.
    Remove the older plugin, e.g.: dsh plugin --profile web remove <package>"
fi
ok "profile composes cleanly"

# ---------------------------------------------------------------------------
# 4. Native Messaging host
# ---------------------------------------------------------------------------
step "Installing the browser launcher"

HOST_DIR="$DSH_HOME/native-host"
HOST_JS="$HOST_DIR/dsh-native-host.js"
WRAPPER="$HOST_DIR/dsh-native-host"
mkdir -p "$HOST_DIR"
[ -f "$NATIVE_HOST_SOURCE" ] || die "the downloaded package is missing native-host/dsh-native-host.js"
cp "$NATIVE_HOST_SOURCE" "$HOST_JS"
chmod +x "$HOST_JS"

# Chrome starts GUI processes with a reduced PATH. Absolute paths keep the
# launcher working after the terminal closes or the extension folder moves.
NODE_BIN="$(command -v node)"
cat > "$WRAPPER" <<EOF
#!/bin/bash
exec "$NODE_BIN" "$HOST_JS"
EOF
chmod +x "$WRAPPER"
ok "launcher files installed in $HOST_DIR"

MANIFEST_JSON="$(cat <<EOF
{
  "name": "$HOST_NAME",
  "type": "stdio",
  "path": "$WRAPPER",
  "stdio": true,
  "description": "Starts the local DSH server (dsh web) on demand for the DSH Chrome extension.",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)"

# Register with every Chromium-family browser actually present: the extension
# may be loaded in any of them, and an unused manifest is harmless.
if [ "$OS" = "Darwin" ]; then
  SUPPORT="$HOME/Library/Application Support"
  BROWSER_DIRS="$SUPPORT/Google/Chrome
$SUPPORT/Google/Chrome Beta
$SUPPORT/Google/Chrome Canary
$SUPPORT/Chromium
$SUPPORT/Microsoft Edge
$SUPPORT/BraveSoftware/Brave-Browser
$SUPPORT/Vivaldi"
else
  CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSER_DIRS="$CONFIG_HOME/google-chrome
$CONFIG_HOME/google-chrome-beta
$CONFIG_HOME/chromium
$CONFIG_HOME/microsoft-edge
$CONFIG_HOME/BraveSoftware/Brave-Browser
$CONFIG_HOME/vivaldi"
fi

INSTALLED_COUNT=0
while IFS= read -r browser_dir; do
  [ -n "$browser_dir" ] || continue
  [ -d "$browser_dir" ] || continue
  target="$browser_dir/NativeMessagingHosts"
  mkdir -p "$target"
  manifest_path="$target/$HOST_NAME.json"
  printf '%s\n' "$MANIFEST_JSON" > "$manifest_path"
  node -e '
    const fs = require("node:fs");
    const [file, wrapper, origin] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.path !== wrapper || !manifest.allowed_origins.includes(origin)) process.exit(1);
  ' "$manifest_path" "$WRAPPER" "chrome-extension://$EXTENSION_ID/" \
    || die "Chrome launcher registration could not be verified at $manifest_path"
  ok "launcher registered in $(basename "$browser_dir")"
  INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
done <<EOF
$BROWSER_DIRS
EOF

if [ "$INSTALLED_COUNT" -eq 0 ]; then
  warn "no Chromium-family browser profile found; install Chrome, then re-run this script"
fi

# ---------------------------------------------------------------------------
# 5. CodeMax model provider
# ---------------------------------------------------------------------------
# Browser control now rides dsh web's own /chrome/mcp + /chrome/ws endpoints;
# there is no standalone daemon to provision. The installer does not start the
# server early solely to mint a key: provider configuration remains optional,
# and can be completed after the final dsh web self-test below.
#
# Every failure here is a warning: an install without a model provider is still
# a working install, and the user is told exactly how to finish the job.
step "Configuring the CodeMax model provider"

CODEX_TOKEN_CLI="$PROFILE_DIR/node_modules/@orba/dsh-codemax-skills/lib/cli.js"
LUMINA_URL="https://lumina.build.toolsfdg.net/lumina/settings/api-keys?spaceId=0"

if [ "${DSH_SKIP_LLM_KEY:-0}" = "1" ]; then
  warn "DSH_SKIP_LLM_KEY=1; skipping model-provider configuration."
elif [ ! -f "$CODEX_TOKEN_CLI" ]; then
  warn "the codemax-skills CLI is missing; skipping model-provider configuration."
elif node "$CODEX_TOKEN_CLI" provider-status >/dev/null 2>&1; then
  ok "the CodeMax model provider is already configured"
else
  # 自动获取现在要求 dsh web + 扩展已经连接。安装必须一路装到底,
  # 不为此提前起第二套生命周期，也不停下来提问；自测会在下一步启动
  # dsh web，之后这条命令即可走共享的 /chrome/mcp 端点。
  warn "no model provider configured yet. After loading the extension, finish it with:"
  warn "  node $CODEX_TOKEN_CLI acquire llm"
  warn "or create a key at $LUMINA_URL and run:"
  warn "  echo <key> | node $CODEX_TOKEN_CLI set-provider"
fi

# ---------------------------------------------------------------------------
# 6. Self-test
# ---------------------------------------------------------------------------
step "Verifying the host can start the server"

# Speak the real Native Messaging framing (4-byte little-endian length + JSON)
# straight to the wrapper, exactly as Chrome would.
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
  warn "python3 not found; skipping the automated self-test"
else
  SELFTEST_PY="$(mktemp -t dsh-selftest-XXXXXX).py"
  trap 'rm -f "$VERIFY_JS" "$SELFTEST_PY"' EXIT
  cat > "$SELFTEST_PY" <<'DSH_SELFTEST_EOF'
import json, struct, subprocess, sys, time, socket

wrapper, port = sys.argv[1], int(sys.argv[2])

def call(payload, timeout):
    body = json.dumps(payload).encode()
    proc = subprocess.run(
        [wrapper],
        input=struct.pack("<I", len(body)) + body,
        capture_output=True,
        timeout=timeout,
    )
    out = proc.stdout
    if len(out) < 4:
        raise SystemExit(
            "  the host returned no response (exit %s).\n  stderr: %s"
            % (proc.returncode, proc.stderr.decode(errors="replace")[:400])
        )
    length = struct.unpack("<I", out[:4])[0]
    return json.loads(out[4:4 + length].decode())

status = call({"cmd": "status"}, 30)
if not status.get("ok"):
    raise SystemExit("  the host reported an error: %s" % status)
if not status.get("dsh"):
    raise SystemExit("  the host could not locate the dsh binary")
print("  host reachable; dsh at %s" % status["dsh"])

reply = call({"cmd": "start", "target": "web", "host": "127.0.0.1", "port": port}, 90)
if not reply.get("ok"):
    raise SystemExit("  the host failed to start dsh web: %s" % reply)

deadline = time.time() + 30
while time.time() < deadline:
    probe = socket.socket()
    probe.settimeout(1)
    connected = probe.connect_ex(("127.0.0.1", port)) == 0
    probe.close()
    if connected:
        state = "was already running" if reply.get("alreadyUp") else "started"
        print("  dsh web %s and is listening on 127.0.0.1:%d" % (state, port))
        break
    time.sleep(1)
else:
    raise SystemExit("  dsh web never began listening on port %d" % port)
DSH_SELFTEST_EOF
  if ! "$PYTHON" "$SELFTEST_PY" "$WRAPPER" "$WEB_PORT"; then
    LOG="$HOME/.dsh-chrome/logs/dsh-web.log"
    if [ -f "$LOG" ]; then
      printf '\n  last lines of %s:\n' "$LOG" >&2
      tail -20 "$LOG" >&2
    fi
    die "the self-test failed; the extension would not be able to start the server"
  fi
  ok "the host starts dsh web successfully"
fi

# ---------------------------------------------------------------------------
step "Installation complete"
cat <<EOF

  Runtime:          ready
  Browser launcher: ready
  Extension folder: $SCRIPT_DIR

  One Chrome security step remains:
    1. Open chrome://extensions and enable Developer mode.
    2. Click "Load unpacked" and choose the extension folder above.

  You do not need to copy an extension id or run another shell script.
  If the extension was already open, click Reload on its extension card.

EOF
ok "launcher authorized for extension $EXTENSION_ID"
