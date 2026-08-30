import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const install = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const distribution = fs.readFileSync(path.join(root, "..", "updater", "dsh-install.sh"), "utf8");

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

  it("lets the bundled installer provision Node and reports pending Chrome work", () => {
    expect(distribution).not.toContain("node not found. Install Node 22+");
    expect(distribution).toContain("Extension status: waiting for you to click Load unpacked.");
    expect(distribution).toContain("DSH runtime installation is complete");
  });
});
