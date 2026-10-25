# vendor/highlight

`highlight.esm.js` — highlight.js v11 的浏览器 ESM 包,**已构建好并提交进仓库**。

## 为什么是预构建产物

`AGENTS.md` 规定 Extension 除 `composer-src` 外不引入构建步骤。而 highlight.js 官方
npm 包里的 `lib/` 是 CommonJS(`module.exports`),`es/` 只是一层转发到 `lib/` 的壳 ——
两者浏览器原生 ESM 都直接加载不了。

所以这里放的是一次性打好的产物:**日常开发与加载都不需要任何构建**,扩展像加载
任何一个普通 `.js` 那样 `import` 它。只有在升级 highlight.js 版本时才需要重跑下面
这条命令,把新产物替换进来。

## 重新生成

`REBUILD-entry.mjs` 是打包入口,决定收录哪些语言。

```sh
npm pack highlight.js@11 && tar xzf highlight.js-*.tgz
mkdir -p node_modules && cp -r package node_modules/highlight.js
npx esbuild REBUILD-entry.mjs --bundle --format=esm --minify --outfile=highlight.esm.js
```

## 收录的语言

当前产物基于 highlight.js 11.12.0,共 42 种:

javascript、typescript、json、bash、shell、python、go、rust、java、kotlin、scala、groovy、
c、cpp、csharp、objectivec、swift、dart、php、ruby、perl、lua、r、haskell、elixir、
sql、graphql、protobuf、yaml、ini(含 toml)、xml(含 HTML/SVG/Vue)、css、scss、less、
markdown、diff、dockerfile、makefile、powershell、nginx、http、plaintext。

对齐 web 端代码块(Shiki 按需加载约 60 种语言)的常见覆盖面;整包仍按需懒加载,
不挡侧栏首帧。

未收录的语言不会报错,只是不着色 —— 见 `features/chat/code-highlight.js` 的降级处理。
需要新增语言时,在 `REBUILD-entry.mjs` 里加一行 import 并把它放进 `registerLanguage` 的表,
然后重跑上面的命令。

## 许可

highlight.js 使用 BSD-3-Clause,许可原文见同目录 `LICENSE`。
