# vendor/qrcode

`qrcode.esm.js` —— [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4
(MIT,见 `LICENSE`),给设置页「移动端访问」画配对二维码用。

## 为什么是搬运而不是依赖

扩展不引入构建步骤(见 `../highlight/README.md`)。上游包只有一份 UMD 的 `qrcode.js`,
浏览器原生 ESM 加载不了,所以这里放的是**原样复制**的源码,只把文件尾那段
`(function (factory) { … define / module.exports … })` 换成一行 `export default qrcode;`。
dsh-mobile-bridge 自己的 `/mobileaccess/qr` 用的也是同一个库同一个版本,两边画出来的码一致。

## 重新生成

```sh
npm pack qrcode-generator@1.4.4 && tar xzf qrcode-generator-*.tgz
n=$(grep -n "^(function (factory) {" package/qrcode.js | cut -d: -f1)
{ echo "// qrcode-generator 1.4.4 …"; head -n $((n-1)) package/qrcode.js; echo "export default qrcode;"; } > qrcode.esm.js
```
