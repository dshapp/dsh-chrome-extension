#!/usr/bin/env bash
# =============================================================================
# DSH one-shot installer
#
# Brings a machine from "nothing installed" to "the Chrome extension can start
# the dsh server by itself":
#
#   1. node / npm / pnpm            (installed globally when missing)
#   2. dsh + its two plugins        (into the web profile; the plugins come
#                                    from registry.npmjs.org)
#   3. the Native Messaging host    (so Chrome can launch dsh web on demand)
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
#   DSH_REGISTRY       registry for the dsh CLI itself (and the pnpm fallback)
#   DSH_PUBLIC_REGISTRY registry for the public plugins (dsh-chrome-control,
#                      dsh-kimi-computer-use); defaults to registry.npmjs.org
#   DSH_HOME           dsh state directory (default ~/.dsh)
#   DSH_WEB_PORT       port the installer starts dsh web on (default 3080)
# =============================================================================
set -euo pipefail

# dsh 0.1.2-rc.1 及其完整依赖集已发布到公共 npm。部分内网镜像的
# prerelease 元数据不同步（包能单独查到，但解析 ^0.1.2-rc.1 仍会 ETARGET），
# 因而默认直接使用权威源；受限网络仍可通过 DSH_REGISTRY 覆盖。
REGISTRY="${DSH_REGISTRY:-https://registry.npmjs.org/}"
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

# 两个插件都装 @latest —— 每次 install 都收敛到当前发布的最新版。
#
# 不再用 caret pin(原来是 dsh-chrome-control@^0.2.0)。0.x 的 caret 锁 minor,
# 会把 chrome-control 永久卡在 0.2.x,而 latest 已经是 0.3.x。
# 实测 0.3.2 的 cordis.patch.yml 仍然只插 chrome-server + chrome-skills 两行,
# 仍然把 /chrome/mcp + /chrome/ws + /chrome/status 挂在 dsh web 自己的 HTTP
# server 上(README 与 lib/server.js 均确认),也就是本安装器和扩展依赖的那套
# 契约没变;0.3.x 多出来的 binaries/<platform>/chrome-daemon 由插件自己 spawn
# 并做 build-hash 对齐,对扩展不可见。所以升级不需要改扩展或 native host。
#
# 它是"不低于",不是"等于",因此 0.3.x 正常通过。
CHROME_PKG="dsh-chrome-control@latest"
KIMI_PKG="dsh-kimi-computer-use@latest"

ALL_PKGS="$CHROME_PKG $KIMI_PKG"

# dsh 本体与上面两个插件相反,钉死在一个确定版本上,不跟 latest。
# 插件是自家发布、契约稳定的,收敛到最新没风险;dsh 是整个运行时的地基,
# 一次版本变化会同时影响 cordis loader、profile 组合和 native host 冷启动,
# 而这个安装器是无人值守跑的 —— 装到哪个版本必须可预期,不能取决于当天
# latest 指向谁(尤其 latest 可能指向一个 rc)。
# 升级就改这一行,让版本变更留在 git 历史里,而不是散在各台机器的安装时刻。
DSH_VERSION="0.1.2-rc.1"
DSH_PKG="@deepseek-ai/dsh@$DSH_VERSION"

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

usage() { sed -n '3,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
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

# 装的是 unpacked 目录,所以"版本"就是 manifest.json 里的那个 —— 用户在
# chrome://extensions 卡片上看到的同一个值。读不到不致命:摘要少一行而已,
# 不该因此让一次成功的安装以非零退出。
read_extension_version() {
  [ -f "$EXTENSION_MANIFEST" ] || return 1
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!manifest.version) process.exit(1);
    process.stdout.write(String(manifest.version));
  ' "$EXTENSION_MANIFEST"
}
EXTENSION_VERSION="$(read_extension_version 2>/dev/null || echo unknown)"

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
# 用来装 dsh 本体,以及在独立脚本失败时兜底装 pnpm。
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

# 与 npm_global 同一套 sudo 判定。卸载用,失败无所谓(没装过就是没装过)。
npm_global_uninstall() {
  local prefix
  prefix="$(npm prefix -g 2>/dev/null || echo /usr/local)"
  if [ -w "$prefix/lib/node_modules" ] 2>/dev/null || [ -w "$prefix" ]; then
    npm uninstall -g "$@"
  else
    sudo npm uninstall -g "$@"
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
step "Installing dsh $DSH_VERSION"
# 无条件重装,不做 "已存在就跳过"。跳过看着省事,实际上把用错布局装出来的
# dsh 永久锁死:历史上用 pnpm 且漏了 --node-linker=hoisted 装出来的 dsh
# 能跑 --version、能过 --dump-config,却在 boot 时炸成
# "Cannot find package '@deepseek-ai/cordis-plugin-timer'"。只要"存在即跳过",
# 重跑脚本永远修不好它。每次都重装,脚本就成了幂等的修复入口。
#
# 走 npm 而不是 pnpm。dsh 的 cordis loader 在运行时按名字 import 上百个
# @deepseek-ai/* 插件,要求这些兄弟包在同一层 node_modules 里可见。
# npm -g 本来就是平铺布局,天然满足;pnpm 默认把每个包隔离在 store 里,
# 必须靠 --node-linker=hoisted 才能摊平成同样的形状 —— 也就是说 hoisted
# 一直是在把 pnpm 掰回 npm 的行为。既然如此,直接用 npm,少一个能配错的旋钮。
#
# 先 uninstall 再 install:清掉可能存在的旧布局(比如之前 pnpm 装的那份),
# 避免残留的 node_modules 结构被原地复用。没装过就是没装过,吞掉退出码。
#
# 顺带把 pnpm 那份也卸掉:两份 dsh 同时在 PATH 上时,谁在前面谁生效,
# 会出现"装了新版却在跑旧版"的静默不一致。这里以 npm 装的为准。
pnpm remove -g @deepseek-ai/dsh >/dev/null 2>&1 || true
npm_global_uninstall @deepseek-ai/dsh >/dev/null 2>&1 || true
if ! npm_global "$DSH_PKG" --registry "$REGISTRY"; then
  die "failed to install $DSH_PKG from $REGISTRY.
    Check that this exact version still exists there:
      npm view $DSH_PKG version --registry $REGISTRY"
fi
# npm 刚装完,新的 bin 可能还不在当前 shell 的 hash 表里。
hash -r 2>/dev/null || true
command -v dsh >/dev/null 2>&1 || die "dsh is still unavailable after installation.
    npm installs it into \"$(npm prefix -g)/bin\"; make sure that directory is
    on your PATH, then run this installer again."

# 钉了版本就要验版本,否则钉了等于没钉。装完 PATH 上解析到的不一定是刚装的
# 那份 —— 机器上可能并存 Homebrew / pnpm 的 dsh 且排在前面,那样后续所有步骤
# (profile 组合、落盘给 native host 的 dshBin、重启 server)都会用错版本,
# 而且全程不报错。这里一次断言,把这种静默不一致挡在安装期。
INSTALLED_DSH_VERSION="$(dsh --version 2>/dev/null | tr -d '[:space:]')"
if [ -z "${INSTALLED_DSH_VERSION:-}" ]; then
  warn "could not read the installed dsh version; continuing"
elif [ "$INSTALLED_DSH_VERSION" != "$DSH_VERSION" ]; then
  die "expected dsh $DSH_VERSION but 'dsh' on PATH reports $INSTALLED_DSH_VERSION.
    Another dsh is shadowing the one just installed. Find it with 'which -a dsh'
    and remove it (a Homebrew or pnpm copy is the usual cause), then re-run."
fi
ok "dsh $DSH_VERSION"

# 本次装出来的那份 dsh 的绝对路径。上面刚把 pnpm 那份卸掉,所以 command -v
# 解析到的就是刚用 npm 装的这份 —— 而不是机器上可能同时存在的 Homebrew 版本。
# 后面停机重启、以及落盘给 native host 的都用它,
# 避免"装了新版却在跑旧版"这种静默不一致。
DSH_BIN_ABS="$(command -v dsh)"
ok "using dsh at $DSH_BIN_ABS"

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
# 整个 web profile 直接删掉重建,不做增量修补。
#
# 光靠 add 是不够的。它确实能改写依赖范围(实测:^0.1.7 的旧 profile 跑一次
# add ^0.2.0 会变成 ^0.2.6),但**不会**清理 dsh.profile.bundles 里改名前的
# 旧身份 —— 实测 dsh plugin add 之后 ["dsh-chrome-control","dsh-chrome"]
# 里的 dsh-chrome 原样留着,dsh 随后以 "cannot resolve profile bundle" 拒绝
# 启动,而且重跑脚本永远修不好。同类残留还有装了一半的依赖树、用错 registry
# 解析出来的版本、旧 .npmrc。
#
# 全删就没有"漏掉哪一种"的问题,脚本因此是一个可靠的修复入口。profile 里
# 除这三个插件外没有用户数据(会话/凭据/设置都在 DSH_HOME 的别处),删了不丢东西。
if [ -d "$PROFILE_DIR" ]; then
  warn "removing existing web profile for a clean reinstall"
  rm -rf "$PROFILE_DIR"
fi

# 把 registry 写进 profile 的 .npmrc,而不是靠命令行 --registry:后续任何
# pnpm 操作(升级、重装)都继续遵守同一来源,不依赖命令行传了什么。
# 首次安装时 profile 目录还不存在('dsh plugin add' 才会创建它),
# 但 .npmrc 必须在 add 之前就位,否则第一次解析仍会走错源。
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/.npmrc" <<EOF
registry=$PUBLIC_REGISTRY
EOF

# shellcheck disable=SC2086
if ! dsh plugin --profile web add $ALL_PKGS; then
  die "plugin installation failed for $ALL_PKGS.
    dsh-chrome-control and dsh-kimi-computer-use come from the public npm
    registry ($PUBLIC_REGISTRY). Check network/proxy access to it, or
    override with DSH_PUBLIC_REGISTRY=<url>."
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
  # 只认 shell 垫片。npm 装的 bin.js 首行是 "#!/usr/bin/env node",光判 '#!'
  # 会把它也当垫片,一旦将来 bin.js 里出现 "exec ....js" 字样就会抠错路径;
  # 判到 sh/bash 才动手,node 脚本一律走下面的 realpath。
  if head -1 "$bin" 2>/dev/null | grep -qE '^#!.*(sh|bash)$' \
     && grep -q 'exec .*\.js' "$bin" 2>/dev/null; then
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

# 注意用裸包名,不能用 *_PKG —— 那些带 @latest,是给 add 的安装 spec,
# 而 verify_bundle 要的是 node 解析用的包名。
for pkg in dsh-chrome-control dsh-kimi-computer-use; do
  if version="$(verify_bundle "$pkg")"; then
    ok "$pkg@$version"
  else
    die "$pkg is installed but unusable (see the message above)."
  fi
done

# The composed tree is the real proof that the profile boots. --dump-config
# renders the tree without instantiating it, so it happily prints a config the
# loader would reject; check for repeated ids explicitly, because two bundles
# inserting the same id abort boot with "duplicate loader entry id".
# 不再每次删 profile 之后,这里是残留的唯一兜底,所以报错必须可操作:
# 最典型的一种是 bundles 里留着改名前的旧身份(如 dsh-chrome),add 不会
# 清理它,dsh 会以 "cannot resolve profile bundle" 拒绝启动。
COMPOSED="$(dsh --profile web --dump-config 2>&1)" || {
  printf '%s\n' "$COMPOSED" >&2
  case "$COMPOSED" in
    *"cannot resolve profile bundle"*)
      die "the profile lists a bundle that is not installed (see above).
    It is usually a plugin that was renamed; drop the stale entry with:
      dsh plugin --profile web remove <package>
    or start over from a clean profile:
      rm -rf \"$PROFILE_DIR\" && re-run this installer" ;;
  esac
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
printf -v DSH_HOME_QUOTED '%q' "$DSH_HOME"
printf -v NODE_BIN_QUOTED '%q' "$NODE_BIN"
printf -v HOST_JS_QUOTED '%q' "$HOST_JS"
cat > "$WRAPPER" <<EOF
#!/bin/bash
export DSH_HOME=$DSH_HOME_QUOTED
exec $NODE_BIN_QUOTED $HOST_JS_QUOTED
EOF
chmod +x "$WRAPPER"
ok "launcher files installed in $HOST_DIR"

# ── host 配置落盘 ────────────────────────────────────────────────────────────
# dshBin:机器上可能并存 Homebrew / npm -g / pnpm 三份 dsh,而 host 的
# resolveDsh() 只能按固定顺序猜。装的是哪一份只有本脚本知道(它就是刚装的那个),
# 所以落一份盘,让 host 冷启动 server 时不必再猜。每次重跑都覆盖。
HOST_CONFIG="$DSH_HOME/dsh-chrome-update.json"
cat > "$HOST_CONFIG" <<EOF
{
  "dshBin": "$DSH_BIN_ABS",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
ok "host configuration recorded (dsh path)"

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
# 5. Restart the server on the freshly installed dsh
# ---------------------------------------------------------------------------
# 上面刚把 dsh 整个重装、并把 profiles/web 删掉重建。此刻若还有一个 server
# 在跑,它用的是旧二进制 + 已经被删掉的 profile —— 端口通、请求也能应答,
# 但新装的插件一个都不在里面。旧自检只探端口,这种状态照样打绿勾,
# 于是用户拿到"安装成功"却发现功能没变。
#
# 所以这里不问状态、直接收敛:端口上有旧的就停掉,然后用本次装出来的
# $DSH_BIN_ABS 起一个新的。
step "Restarting the DSH server on the new build"

port_pid() {
  lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

RESTARTED=0
if ! command -v lsof >/dev/null 2>&1; then
  warn "lsof not found; cannot reclaim port $WEB_PORT, leaving any running server alone"
else
  OLD_PID="$(port_pid)"
  if [ -n "$OLD_PID" ]; then
    # 端口不一定是 dsh 占的。别人的服务恰好用 3080 是完全可能的,
    # 而这里的动作是 kill —— 认错了就是在破坏用户环境。所以先验明正身,
    # cmdline 对不上宁可退出让人工处理,也不猜。
    OLD_CMD="$(ps -o command= -p "$OLD_PID" 2>/dev/null || true)"
    case "$OLD_CMD" in
      *dsh*|*bin.js*) ;;
      *)
        die "port $WEB_PORT is held by PID $OLD_PID, which does not look like dsh:
    $OLD_CMD
    Free that port (or set DSH_WEB_PORT to another one) and re-run this installer." ;;
    esac

    warn "stopping the running server (PID $OLD_PID) so the new build takes effect"
    kill "$OLD_PID" 2>/dev/null || true
    # 先给 SIGTERM 一点时间优雅退出(它要落盘会话状态),不行再强杀。
    WAITED=0
    while [ "$WAITED" -lt 10 ] && [ -n "$(port_pid)" ]; do
      sleep 0.5
      WAITED=$((WAITED + 1))
    done
    if [ -n "$(port_pid)" ]; then
      warn "it did not exit in time; forcing it down"
      kill -9 "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
    [ -z "$(port_pid)" ] || die "port $WEB_PORT is still busy after stopping PID $OLD_PID."
    RESTARTED=1
  fi

  # detached + nohup:本脚本退出后 server 必须继续活着。日志沿用 host 那份,
  # 排查时只有一个地方要看。
  SERVER_LOG="$HOME/.dsh-chrome/logs/dsh-web.log"
  mkdir -p "$(dirname "$SERVER_LOG")"
  # 不能直接跑 $DSH_BIN_ABS。它的两种形态都会在精简环境里静默失败:
  #   - npm 装的是指向 lib/bin.js 的符号链接,首行 `#!/usr/bin/env node`
  #   - pnpm 装的是 /bin/sh 垫片,末尾是裸的 `exec node .../bin.js`
  # 两者都要求 node 在 PATH 上,而 Homebrew 的 node 在 /opt/homebrew/bin,
  # GUI 进程和精简环境里经常没有 —— 于是 "env: node: No such file or directory",
  # 端口永远起不来。所以统一用绝对路径的 node 去跑那个 .js。
  #
  # 注意不能无条件 grep 一个 .js 出来:npm 装的 bin.js 本身就是 JS 源码,
  # 里面含 "./profile-boot-*.js" 这类内部字符串,grep 会抓到它,拼出一条
  # 不存在的相对路径,然后退回执行入口本身 —— 正好绕回上面那个失败。
  # 所以先判断形态:只有真的是 shell 垫片时才去抠 exec 的目标,
  # 否则(符号链接/真实脚本)直接对它取 realpath。
  DSH_ENTRY_JS=""
  if head -1 "$DSH_BIN_ABS" 2>/dev/null | grep -qE '^#!.*(sh|bash)$' \
     && grep -q 'exec .*\.js' "$DSH_BIN_ABS" 2>/dev/null; then
    # 垫片:取 exec 的那个 .js。里面有 Windows 分支($basedir_win),排掉。
    DSH_ENTRY_JS="$(grep -oE '"[^"]*\.js"' "$DSH_BIN_ABS" 2>/dev/null \
      | grep -v basedir_win | head -1 | tr -d '"')"
    if [ -n "${DSH_ENTRY_JS:-}" ]; then
      DSH_ENTRY_JS="${DSH_ENTRY_JS//\$basedir/$(dirname "$DSH_BIN_ABS")}"
    fi
  else
    # 符号链接或真实的 node 脚本:realpath 就是要跑的 .js。
    DSH_ENTRY_JS="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' \
      "$DSH_BIN_ABS" 2>/dev/null || true)"
  fi
  if [ -n "${DSH_ENTRY_JS:-}" ] && [ -f "$DSH_ENTRY_JS" ]; then
    nohup "$NODE_BIN" "$DSH_ENTRY_JS" web --no-open --host 127.0.0.1 --port "$WEB_PORT" \
      >>"$SERVER_LOG" 2>&1 &
  else
    nohup "$DSH_BIN_ABS" web --no-open --host 127.0.0.1 --port "$WEB_PORT" \
      >>"$SERVER_LOG" 2>&1 &
  fi
  NEW_PID=$!
  disown "$NEW_PID" 2>/dev/null || true

  WAITED=0
  while [ "$WAITED" -lt 60 ] && [ -z "$(port_pid)" ]; do
    sleep 0.5
    WAITED=$((WAITED + 1))
  done
  if [ -z "$(port_pid)" ]; then
    printf '\n  last lines of %s:\n' "$SERVER_LOG" >&2
    tail -20 "$SERVER_LOG" >&2 2>/dev/null || true
    die "the new server never began listening on port $WEB_PORT."
  fi
  if [ "$RESTARTED" -eq 1 ]; then
    ok "server restarted on the new build (127.0.0.1:$WEB_PORT, PID $(port_pid))"
  else
    ok "server started (127.0.0.1:$WEB_PORT, PID $(port_pid))"
  fi
fi

# ---------------------------------------------------------------------------
step "Installation complete"
cat <<EOF

  Runtime:           ready
  Browser launcher:  installed
  Auto-update:       ready (silent; checks every 3h)
  Extension folder:  $SCRIPT_DIR
  Extension version: $EXTENSION_VERSION

  One Chrome security step remains:
    1. Open chrome://extensions and enable Developer mode.
    2. Click "Load unpacked" and choose the extension folder above.

  You do not need to copy an extension id or run another shell script.
  If the extension was already open, click Reload on its extension card.

EOF
ok "launcher authorized for extension $EXTENSION_ID"
