// 文件类型图标:取自 lucide(https://github.com/lucide-icons/lucide)的 stroke 线稿,
// 24×24、stroke=currentColor,和 Web ui-primitives FileTypeIcon / LinkIcon 的分类口径一致:
// - present 交付卡用细分类(fileTypeIconName,对齐 classifyFileType);
// - 产出 chip / 行内 mention 用 6 类粗分类(linkIconName,对齐 classifyLinkPath)。
// 只内联用到的图标,不引入整包 lucide。
import { fileExtension } from "./user-content.js";

const svgEl = (name, attrs) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/// lucide 图标源数据([[元素名, 属性], ...])。路径逐字来自上游 SVG,勿手改。
const ICONS = Object.freeze({
  file: [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }]
  ],
  "file-text": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M10 9H8" }],
    ["path", { d: "M16 13H8" }],
    ["path", { d: "M16 17H8" }]
  ],
  "file-code": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M10 12.5 8 15l2 2.5" }],
    ["path", { d: "m14 12.5 2 2.5-2 2.5" }]
  ],
  "file-image": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["circle", { cx: 10, cy: 12, r: 2 }],
    ["path", { d: "m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22" }]
  ],
  "file-play": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M15.033 13.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56v-4.704a.645.645 0 0 1 .967-.56z" }]
  ],
  "file-spreadsheet": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M8 13h2" }],
    ["path", { d: "M14 13h2" }],
    ["path", { d: "M8 17h2" }],
    ["path", { d: "M14 17h2" }]
  ],
  "file-type": [
    ["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M11 18h2" }],
    ["path", { d: "M12 12v6" }],
    ["path", { d: "M9 13v-.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v.5" }]
  ],
  "file-pen": [
    ["path", { d: "M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34" }],
    ["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
    ["path", { d: "M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z" }]
  ],
  folder: [
    ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]
  ],
  presentation: [
    ["path", { d: "M2 3h20" }],
    ["path", { d: "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3" }],
    ["path", { d: "m7 21 5-5 5 5" }]
  ],
  globe: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }],
    ["path", { d: "M2 12h20" }]
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }]
  ],
  music: [
    ["path", { d: "M9 18V5l12-2v13" }],
    ["circle", { cx: 6, cy: 18, r: 3 }],
    ["circle", { cx: 18, cy: 16, r: 3 }]
  ],
  "chevron-down": [
    ["path", { d: "m6 9 6 6 6-6" }]
  ],
  "chevron-right": [
    ["path", { d: "m9 18 6-6-6-6" }]
  ],
  "chevron-up": [
    ["path", { d: "m18 15-6-6-6 6" }]
  ],
  "chevron-left": [
    ["path", { d: "m15 18-6-6 6-6" }]
  ],
  plus: [
    ["path", { d: "M5 12h14" }],
    ["path", { d: "M12 5v14" }]
  ],
  minus: [
    ["path", { d: "M5 12h14" }]
  ],
  "arrow-up-down": [
    ["path", { d: "m21 16-4 4-4-4" }],
    ["path", { d: "M17 20V4" }],
    ["path", { d: "m3 8 4-4 4 4" }],
    ["path", { d: "M7 4v16" }]
  ],
  x: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }]
  ],
  check: [
    ["path", { d: "M20 6 9 17l-5-5" }]
  ],
  copy: [
    ["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]
  ],
  "trash-2": [
    ["path", { d: "M10 11v6" }],
    ["path", { d: "M14 11v6" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]
  ],
  play: [
    ["path", { d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" }]
  ],
  pause: [
    ["rect", { x: 14, y: 3, width: 5, height: 18, rx: 1 }],
    ["rect", { x: 5, y: 3, width: 5, height: 18, rx: 1 }]
  ],
  pencil: [
    ["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }],
    ["path", { d: "m15 5 4 4" }]
  ],
  "square-pen": [
    ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }],
    ["path", { d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" }]
  ],
  "arrow-up": [
    ["path", { d: "m5 12 7-7 7 7" }],
    ["path", { d: "M12 19V5" }]
  ],
  "arrow-down": [
    ["path", { d: "M12 5v14" }],
    ["path", { d: "m19 12-7 7-7-7" }]
  ],
  "arrow-right": [
    ["path", { d: "M5 12h14" }],
    ["path", { d: "m12 5 7 7-7 7" }]
  ],
  "arrow-left": [
    ["path", { d: "m12 19-7-7 7-7" }],
    ["path", { d: "M19 12H5" }]
  ],
  square: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }]
  ],
  "triangle-alert": [
    ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }]
  ],
  sparkles: [
    ["path", { d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" }],
    ["path", { d: "M20 2v4" }],
    ["path", { d: "M22 4h-4" }],
    ["circle", { cx: 4, cy: 20, r: 2 }]
  ],
  brain: [
    ["path", { d: "M12 18V5" }],
    ["path", { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }],
    ["path", { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }],
    ["path", { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }],
    ["path", { d: "M18 18a4 4 0 0 0 2-7.464" }],
    ["path", { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }],
    ["path", { d: "M6 18a4 4 0 0 1-2-7.464" }],
    ["path", { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" }]
  ],
  "list-checks": [
    ["path", { d: "M13 5h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 19h8" }],
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "m3 7 2 2 4-4" }]
  ],
  layers: [
    ["path", { d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" }],
    ["path", { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }],
    ["path", { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }]
  ],
  "git-branch": [
    ["path", { d: "M15 6a9 9 0 0 0-9 9V3" }],
    ["circle", { cx: 18, cy: 6, r: 3 }],
    ["circle", { cx: 6, cy: 18, r: 3 }]
  ],
  "git-fork": [
    ["circle", { cx: 12, cy: 18, r: 3 }],
    ["circle", { cx: 6, cy: 6, r: 3 }],
    ["circle", { cx: 18, cy: 6, r: 3 }],
    ["path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }],
    ["path", { d: "M12 12v3" }]
  ],
  search: [
    ["path", { d: "m21 21-4.34-4.34" }],
    ["circle", { cx: 11, cy: 11, r: 8 }]
  ],
  info: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }]
  ],
  "circle-alert": [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 8v4" }],
    ["path", { d: "M12 16h.01" }]
  ],
  clock: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 6v6l4 2" }]
  ],
  database: [
    ["ellipse", { cx: 12, cy: 5, rx: 9, ry: 3 }],
    ["path", { d: "M3 5V19A9 3 0 0 0 21 19V5" }],
    ["path", { d: "M3 12A9 3 0 0 0 21 12" }]
  ],
  image: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["circle", { cx: 9, cy: 9, r: 2 }],
    ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }]
  ],
  "image-plus": [
    ["path", { d: "M16 5h6" }],
    ["path", { d: "M19 2v6" }],
    ["path", { d: "M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" }],
    ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }],
    ["circle", { cx: 9, cy: 9, r: 2 }]
  ],
  paperclip: [
    ["path", { d: "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" }]
  ],
  "send-horizontal": [
    ["path", { d: "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" }],
    ["path", { d: "M6 12h16" }]
  ],
  "ellipsis-vertical": [
    ["circle", { cx: 12, cy: 12, r: 1 }],
    ["circle", { cx: 12, cy: 5, r: 1 }],
    ["circle", { cx: 12, cy: 19, r: 1 }]
  ],
  "square-dashed-mouse-pointer": [
    ["path", { d: "M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z" }],
    ["path", { d: "M5 3a2 2 0 0 0-2 2" }],
    ["path", { d: "M19 3a2 2 0 0 1 2 2" }],
    ["path", { d: "M5 21a2 2 0 0 1-2-2" }],
    ["path", { d: "M9 3h1" }],
    ["path", { d: "M9 21h2" }],
    ["path", { d: "M14 3h1" }],
    ["path", { d: "M3 9v1" }],
    ["path", { d: "M21 9v2" }],
    ["path", { d: "M3 14v1" }]
  ],
  target: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["circle", { cx: 12, cy: 12, r: 6 }],
    ["circle", { cx: 12, cy: 12, r: 2 }]
  ],
  "panel-left": [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
    ["path", { d: "M9 3v18" }]
  ],
  list: [
    ["path", { d: "M3 5h.01" }],
    ["path", { d: "M3 12h.01" }],
    ["path", { d: "M3 19h.01" }],
    ["path", { d: "M8 5h13" }],
    ["path", { d: "M8 12h13" }],
    ["path", { d: "M8 19h13" }]
  ],
  terminal: [
    ["path", { d: "M12 19h8" }],
    ["path", { d: "m4 17 6-6-6-6" }]
  ],
  "code-xml": [
    ["path", { d: "m18 16 4-4-4-4" }],
    ["path", { d: "m6 8-4 4 4 4" }],
    ["path", { d: "m14.5 4-5 16" }]
  ],
  "message-circle": [
    ["path", { d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" }]
  ],
  "external-link": [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M10 14 21 3" }],
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]
  ],
  "rotate-cw": [
    ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }]
  ],
  "corner-down-left": [
    ["path", { d: "M20 4v7a4 4 0 0 1-4 4H4" }],
    ["path", { d: "m9 10-5 5 5 5" }]
  ],
  circle: [
    ["circle", { cx: 12, cy: 12, r: 10 }]
  ],
  "circle-dot": [
    ["circle", { cx: 12, cy: 12, r: 1 }],
    ["circle", { cx: 12, cy: 12, r: 10 }]
  ],
  "circle-check": [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "m16 9-5.5 5.5L8 12" }]
  ],
  "pencil-line": [
    ["path", { d: "M13 21h8" }],
    ["path", { d: "m15 5 4 4" }],
    ["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }]
  ],
  archive: [
    ["rect", { width: 20, height: 5, x: 2, y: 3, rx: 1 }],
    ["path", { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" }],
    ["path", { d: "M10 12h4" }]
  ],
  "arrow-up-right": [
    ["path", { d: "M7 7h10v10" }],
    ["path", { d: "M7 17 17 7" }]
  ],
  // 置顶 / 取消置顶:会话列表的「已置顶」分区与行内操作按钮用这两枚
  //(对齐 Mac 侧栏右键菜单的 pin / 行首 SFIcon("pin"))。
  pin: [
    ["path", { d: "M12 17v5" }],
    ["path", { d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" }]
  ],
  "pin-off": [
    ["path", { d: "M12 17v5" }],
    ["path", { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" }],
    ["path", { d: "m2 2 20 20" }],
    ["path", { d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" }]
  ],
  // 添加工作目录:抽屉分区标题右侧那颗(对齐 Mac 的 folder.badge.plus)。
  "folder-plus": [
    ["path", { d: "M12 10v6" }],
    ["path", { d: "M9 13h6" }],
    ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]
  ],
  "folder-open": [
    ["path", { d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" }]
  ],
  // ---- 设置页图标:对齐 Mac 设置 TabView 的 SF Symbol 与卡片行尾动作 ----
  // Mac 每个 pane 的 tabItem 都带 systemImage,行尾动作也用符号表达;
  // 扩展原本全是文字,窄侧栏里一排纯文字按钮既挤又难扫读。
  settings: [
    ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
    ["circle", { cx: 12, cy: 12, r: 3 }]
  ],
  cpu: [
    ["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }],
    ["rect", { x: 9, y: 9, width: 6, height: 6 }],
    ["path", { d: "M15 2v2" }],
    ["path", { d: "M15 20v2" }],
    ["path", { d: "M2 15h2" }],
    ["path", { d: "M2 9h2" }],
    ["path", { d: "M20 15h2" }],
    ["path", { d: "M20 9h2" }],
    ["path", { d: "M9 2v2" }],
    ["path", { d: "M9 20v2" }]
  ],
  puzzle: [
    ["path", { d: "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" }]
  ],
  server: [
    ["rect", { x: 2, y: 3, width: 20, height: 8, rx: 2 }],
    ["rect", { x: 2, y: 13, width: 20, height: 8, rx: 2 }],
    ["path", { d: "M6 7h.01" }],
    ["path", { d: "M6 17h.01" }]
  ],
  keyboard: [
    ["path", { d: "M10 8h.01" }],
    ["path", { d: "M12 12h.01" }],
    ["path", { d: "M14 8h.01" }],
    ["path", { d: "M16 12h.01" }],
    ["path", { d: "M18 8h.01" }],
    ["path", { d: "M6 8h.01" }],
    ["path", { d: "M7 16h10" }],
    ["path", { d: "M8 12h.01" }],
    ["rect", { x: 2, y: 4, width: 20, height: 16, rx: 2 }]
  ],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M12 20v2" }],
    ["path", { d: "m4.93 4.93 1.41 1.41" }],
    ["path", { d: "m17.66 17.66 1.41 1.41" }],
    ["path", { d: "M2 12h2" }],
    ["path", { d: "M20 12h2" }],
    ["path", { d: "m6.34 17.66-1.41 1.41" }],
    ["path", { d: "m19.07 4.93-1.41 1.41" }]
  ],
  moon: [
    ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]
  ],
  "circle-half": [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 2v20" }]
  ],
  "triangle-alert-filled": [
    ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }],
    ["path", { d: "M12 9v4" }],
    ["path", { d: "M12 17h.01" }]
  ],
  "circle-help": [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }]
  ],
  package: [
    ["path", { d: "m7.5 4.27 9 5.15" }],
    ["path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }],
    ["path", { d: "m3.3 7 8.7 5 8.7-5" }],
    ["path", { d: "M12 22V12" }]
  ],
  "package-plus": [
    ["path", { d: "M16 16h6" }],
    ["path", { d: "M19 13v6" }],
    ["path", { d: "M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0" }],
    ["path", { d: "m3.3 7 8.7 5 8.7-5" }],
    ["path", { d: "M12 22V12" }]
  ],
  refresh: [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M3 21v-5h5" }]
  ],
  "shield-alert": [
    ["path", { d: "M20 13c0 5-3.5 7.5-7.5 8.5a1 1 0 0 1-.5 0C8.5 20.5 5 18 5 13V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1z" }],
    ["path", { d: "M12 8v4" }],
    ["path", { d: "M12 16h.01" }]
  ],
  download: [
    ["path", { d: "M12 15V3" }],
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
    ["path", { d: "m7 10 5 5 5-5" }]
  ],
  "play-circle": [
    ["path", { d: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" }],
    ["path", { d: "m10 8 6 4-6 4Z" }]
  ]
});

const SVG_ATTRS = Object.freeze({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
  focusable: "false"
});

function attrsToString(attrs) {
  return Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(" ");
}

const markupCache = new Map();
function iconMarkup(name) {
  const key = ICONS[name] ? name : "file";
  if (!markupCache.has(key)) {
    markupCache.set(key, ICONS[key].map(([tag, attrs]) => `<${tag} ${attrsToString(attrs)} />`).join(""));
  }
  return markupCache.get(key);
}

/// 同一套 lucide 图标的字符串形态(要塞进 innerHTML 的场景用)。
export function lucideIconSvg(name, { size = 16, className } = {}) {
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} width="${size}" height="${size}" ${attrsToString(SVG_ATTRS)}>${iconMarkup(name)}</svg>`;
}

/// 一个 lucide 图标元素(stroke 线稿)。name 缺失时退回通用 file。
export function lucideIcon(name, { size = 16, className } = {}) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false"
  });
  if (className) svg.setAttribute("class", className);
  for (const [tag, attrs] of ICONS[name] ?? ICONS.file) svg.append(svgEl(tag, attrs));
  return svg;
}

/// 扩展名 → 细分类(对齐 web EXTENSION_TYPES;只保留判断所需的子集)。
const EXTENSION_KIND = Object.freeze({
  scss: "code", sass: "code", less: "code", vue: "code", svelte: "code", astro: "code",
  bat: "code", cmd: "code", csv: "code", tsv: "code",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
  avif: "image", bmp: "image", ico: "image", tif: "image", tiff: "image", heic: "image", heif: "image",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  pdf: "pdf", ppt: "ppt", pptx: "ppt", key: "ppt",
  mp4: "video", mov: "video", m4v: "video", webm: "video", mkv: "video", avi: "video", mpg: "video", mpeg: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", ogg: "audio", aac: "audio",
  doc: "word", docx: "word", rtf: "word", odt: "word", pages: "word",
  xls: "excel", xlsx: "excel", xlsm: "excel", numbers: "excel"
});

const CODE_FILENAMES = /^(dockerfile|makefile|gnumakefile|cmakelists\.txt|justfile)$/;
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "py", "rb", "go", "rs",
  "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "php", "sh", "bash",
  "zsh", "fish", "ps1", "sql", "toml", "yaml", "yml", "xml", "css", "lua", "pl", "r", "dart",
  "ex", "exs", "erl", "hs", "scala", "clj", "vim", "gradle", "proto", "tf"
]);

/// 细分类(web classifyFileType 的 vanilla 版)。name 可为路径或文件名。
export function fileTypeKind(name) {
  const base = String(name ?? "").split(/[\\/]/).pop().toLowerCase();
  const extension = fileExtension(base).toLowerCase();
  if (CODE_FILENAMES.test(base)) return "code";
  const kind = EXTENSION_KIND[extension];
  if (kind) return kind;
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (extension === "") return "other";
  return "other";
}

const KIND_ICON = Object.freeze({
  code: "file-code", html: "file-code", markdown: "file-pen",
  image: "file-image", pdf: "file-type", word: "file-text",
  excel: "file-spreadsheet", ppt: "presentation",
  video: "file-play", audio: "music", folder: "folder", other: "file"
});

/// present 交付卡 / 文件卡的细分类图标名(web FileTypeIcon)。
export function fileTypeIconName(name) {
  return KIND_ICON[fileTypeKind(name)] ?? "file";
}

/// 产出 chip / 行内 mention 的 6 类粗分类图标名(web LinkIcon.classifyLinkPath)。
export function linkIconName(name) {
  switch (fileTypeKind(name)) {
    case "code":
    case "html": return "file-code";
    case "image": return "file-image";
    case "excel":
    case "pdf":
    case "ppt":
    case "word": return "file-text";
    case "folder": return "folder";
    default: return "file";
  }
}
