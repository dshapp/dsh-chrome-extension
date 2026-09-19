/**
 * 原生宿主收到坏帧时必须回一条结构化错误,而不是直接崩掉。
 *
 * readMessage 在 data 监听器里直接 JSON.parse 帧体,没有任何 try/catch。帧体不是
 * 合法 JSON 时这个 SyntaxError 会把宿主进程带走(实测 exit 1、stdout 0 字节),
 * Chrome 侧只能看到"native host 退出且没有回包"。dispatch 里本来就有
 * bad-message 分支,但那要等 readMessage 正常返回才走得到。
 *
 * 这里直接 spawn 真实的 native-host 脚本喂坏帧 —— 它是协议边界,单测替身证明不了
 * "进程没被带走"这件事。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HOST = fileURLToPath(new URL('../native-host/dsh-native-host.js', import.meta.url))

/** 走一遍真实的请求-应答:写帧,读回长度前缀的应答。 */
function runHost(frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = Buffer.alloc(0)
    let err = ''
    child.stdout.on('data', (chunk) => { out = Buffer.concat([out, chunk]) })
    child.stderr.on('data', (chunk) => { err += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      let body = null
      if (out.length >= 4) {
        const length = out.readUInt32LE(0)
        body = JSON.parse(out.subarray(4, 4 + length).toString('utf8'))
      }
      resolve({ code, stdoutBytes: out.length, body, stderr: err })
    })
    child.stdin.write(Buffer.concat(frames))
    child.stdin.end()
  })
}

/** 长度前缀帧(Chrome 的 native messaging 线格式)。 */
function frame(text) {
  const body = Buffer.from(text, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

test('坏帧:回 bad-message,进程不崩、stderr 干净', async () => {
  const result = await runHost([frame('{not json')])
  assert.equal(result.code, 0, '宿主不应因坏帧非零退出(stderr: ' + result.stderr + ')')
  assert.deepEqual(result.body, { ok: false, reason: 'bad-message' })
  assert.equal(result.stderr, '', '坏帧不应往 stderr 打未捕获异常')
})

test('合法 JSON 但不是对象:同样回 bad-message', async () => {
  const result = await runHost([frame('123')])
  assert.equal(result.code, 0)
  assert.deepEqual(result.body, { ok: false, reason: 'bad-message' })
})

test('正常帧不受影响', async () => {
  const result = await runHost([frame(JSON.stringify({ cmd: 'status' }))])
  assert.equal(result.code, 0)
  assert.equal(result.body?.ok, true)
  assert.equal(result.body?.host, 'com.dsh.chrome')
})

test('未知命令回 unknown-cmd', async () => {
  const result = await runHost([frame(JSON.stringify({ cmd: 'nope' }))])
  assert.equal(result.code, 0)
  assert.deepEqual(result.body, { ok: false, reason: 'unknown-cmd' })
})
