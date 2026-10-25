// 配对二维码:桥接只给文本(dshm:// 配对串),画成图是这一端的事 —— 和 Mac 用
// CoreImage 自己画、桥接的 /mobileaccess/qr 用同一个库画是同一个分工。
//
// 画成一段内联 <svg>,不走 <img src=桥接的 /mobileaccess/qr>:扩展页发起的图片请求
// 带 Sec-Fetch-Site: cross-site,会被宿主的请求围栏挡掉(见 api-client getBlob 的说明),
// 而且老版本桥接根本没有那条路由。
import qrcode from "../../vendor/qrcode/qrcode.esm.js";

/// 码的模块矩阵。纠错级别 M 与 Mac(CIQRCodeGenerator correctionLevel "M")、
/// 桥接(qrcode(0, 'M'))一致。
///
/// 库的默认 stringToBytes 只取每个 UTF-16 码元的低 8 位;这里先自己转成 UTF-8
/// 字节串再交给它,中文设备名也不会被截坏 —— 而不是去改库的全局 stringToBytes。
export function qrMatrix(text, level = "M") {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const qr = qrcode(0, level);
  qr.addData(binary, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (row, col) => qr.isDark(row, col) };
}

/// 一段可直接插进 innerHTML 的 SVG。暗模块按行合成一条 path,
/// 留白(quiet zone)由 margin 个模块的白底给出 —— 深色主题下码也必须是白底黑块,
/// 否则多数扫码器认不出来。
export function qrSvg(text, { margin = 2, label = "" } = {}) {
  const { size, isDark } = qrMatrix(text);
  const total = size + margin * 2;
  let path = "";
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!isDark(row, col)) { col += 1; continue; }
      const start = col;
      while (col < size && isDark(row, col)) col += 1;
      path += `M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`;
    }
  }
  const aria = label ? ` role="img" aria-label="${escapeAttr(label)}"` : ' aria-hidden="true"';
  return `<svg class="mob-qr-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"`
    + ` shape-rendering="crispEdges"${aria}>`
    + `<rect width="${total}" height="${total}" fill="#fff"/>`
    + `<path d="${path}" fill="#000"/></svg>`;
}

function escapeAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
