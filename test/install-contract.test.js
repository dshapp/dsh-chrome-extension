import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");

describe("beginner-friendly dsh-chrome installer contract", () => {
  it("derives and validates the extension id without asking the user", () => {
    expect(install).toContain("derive_extension_id()");
    expect(install).toContain('EXTENSION_MANIFEST="$SCRIPT_DIR/manifest.json"');
    expect(install).not.toContain("DEFAULT_EXTENSION_ID=");
    expect(install).toContain("expected the 32-letter id derived from manifest.json");
  });

  it("the launcher resolves common Linux user and system dsh locations", () => {
    const host = fs.readFileSync(path.join(root, "native-host", "dsh-native-host.js"), "utf8");
    expect(host).toContain('.local/share/pnpm/bin/dsh');
    expect(host).toContain('.local/share/pnpm/dsh');
    expect(host).toContain('/usr/local/bin/dsh');
  });

  it("installs a stable launcher and verifies its authorization", () => {
    expect(install).toContain('HOST_DIR="$DSH_HOME/native-host"');
    expect(install).toContain('cp "$NATIVE_HOST_SOURCE" "$HOST_JS"');
    expect(install).toContain('"allowed_origins": ["chrome-extension://$EXTENSION_ID/"]');
    expect(install).toContain("launcher registration could not be verified");
  });

  it("does not require the separate native-host script", () => {
    const executableLines = install.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(executableLines.some((line) => line.includes("install-native-host.sh"))).toBe(false);
    expect(install).toContain("You do not need to copy an extension id or run another shell script.");
  });

  // 定制业务(binance/CodeMax)已整体移除:安装器与运行时不得再引用它们,
  // 否则被复制到 $DSH_HOME 单独跑的 host 会因断链 import 而连 status 都不通。
  it("references no binance/CodeMax leftovers anywhere in the install chain", () => {
    const host = fs.readFileSync(path.join(root, "native-host", "dsh-native-host.js"), "utf8");
    const swIndex = fs.readFileSync(path.join(root, "sw", "index.js"), "utf8");
    for (const text of [install, host, swIndex]) {
      expect(text).not.toMatch(/binance/i);
      expect(text).not.toMatch(/codemax/i);
    }
  });

  it("still records the installed dsh path for the launcher's cold start", () => {
    // host 的 resolveDsh() 首选 install.sh 落盘的 dshBin,不能随自动更新一起删。
    expect(install).toContain('"dshBin": "$DSH_BIN_ABS"');
    const host = fs.readFileSync(path.join(root, "native-host", "dsh-native-host.js"), "utf8");
    expect(host).toContain("dsh-chrome-update.json");
  });
});
