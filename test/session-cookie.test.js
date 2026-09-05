// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { installSessionCookie } from "../src/platform/dsh/session-cookie.js";

const hostScript = path.resolve(import.meta.dirname, "../native-host/dsh-native-host.js");
const temporaryHomes = [];

afterEach(() => {
  for (const dir of temporaryHomes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function invokeNativeHost(message, credentialsYaml) {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cookie-test-"));
  temporaryHomes.push(dshHome);
  fs.writeFileSync(path.join(dshHome, ".credentials.yaml"), credentialsYaml);
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostScript], {
      env: { ...process.env, DSH_HOME: dshHome }, stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`native host exited ${code}: ${stderr}`));
      const output = Buffer.concat(chunks);
      const length = output.readUInt32LE(0);
      resolve(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
    });
    child.stdin.end(Buffer.concat([header, body]));
  });
}

describe("DSH browser-session cookie", () => {
  it("native host signs the exact v1 authority-bound format", async () => {
    const secret = Buffer.alloc(32, 0x5a);
    const result = await invokeNativeHost(
      { cmd: "cookie", host: "127.0.0.1", port: 3080 },
      `client-connection/browser-session:\n  payload:\n    version: 1\n    secret: ${secret.toString("base64url")}\n`
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe("dsh-auth-" + crypto.createHash("sha256").update("127.0.0.1:3080").digest("base64url"));
    const [, body, signature] = result.value.split(".");
    expect(signature).toBe(crypto.createHmac("sha256", secret).update(body).digest("base64url"));
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ version: 1, authority: "127.0.0.1:3080" });
    expect(payload.expiresAt - payload.issuedAt).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it("rejects unsupported credentials versions", async () => {
    const result = await invokeNativeHost(
      { cmd: "cookie", host: "127.0.0.1", port: 3080 },
      `client-connection/browser-session:\n  payload:\n    version: 2\n    secret: ${Buffer.alloc(32).toString("base64url")}\n`
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported browser-session payload version/);
  });

  it("installs the signed cookie with the required Chrome attributes", async () => {
    const set = vi.fn().mockResolvedValue({ name: "dsh-auth-test" });
    const sendNativeMessage = vi.fn().mockResolvedValue({
      ok: true, name: "dsh-auth-test", value: "v1.body.signature", expirationDate: 12345
    });
    const installed = await installSessionCookie("http://127.0.0.1:3080", {
      chromeApi: { runtime: { sendNativeMessage }, cookies: { set } }
    });
    expect(installed).toBe(true);
    expect(sendNativeMessage.mock.calls[0][1]).toEqual({ cmd: "cookie", host: "127.0.0.1", port: 3080 });
    expect(set).toHaveBeenCalledWith({
      url: "http://127.0.0.1:3080/", name: "dsh-auth-test", value: "v1.body.signature",
      path: "/", expirationDate: 12345, secure: true, httpOnly: true, sameSite: "no_restriction"
    });
  });
});
