/**
 * manifest.json 的 key 必须推出商店版 id。
 *
 * 本机侧的两道闸 —— Native Messaging 宿主(dsh-chrome-control 插件在 dsh 启动时注册)
 * 与 chrome-daemon 的请求守卫 —— 都只认这一个 id。key 一漂,解压加载的开发版就会被
 * 自己的宿主和 daemon 同时拒掉,而表面上只是"连不上"。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { test } from 'node:test'

const STORE_ID = 'kgjjicancjnedmappjhefngdjaommpop'

test('manifest key 推出的 id 就是商店版 id', () => {
  const { key } = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))
  const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)
  const id = [...digest].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('')
  assert.equal(id, STORE_ID)
})
