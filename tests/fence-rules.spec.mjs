/**
 * DNR 围栏规则必须只命中扩展自己发起的请求。
 *
 * 这条规则把 matching 请求的 origin / sec-fetch-site 头摘掉,好让宿主的
 * api-request-trust 放行扩展的 uplink。但 DNR 的 modifyHeaders 对浏览器里所有
 * 匹配 URL 的请求生效,不看发起方:规则不带 initiatorDomains 时,任何普通网页
 * (乃至别的扩展)对同地址的 fetch/XHR 也会被摘掉这两个头,在宿主眼里就成了
 * "可信请求" —— 恰好绕过了这道围栏本来要拦的东西。文件注释原本也写着只应命中
 * 扩展自己的请求(旧代码里那个从没被调用的 partitionKeyFromOrigin 就是旁证)。
 *
 * 扩展页与 service worker 的 initiator 就是扩展 id,网页是页面所在域,所以用
 * initiatorDomains 白名单即可分开。已在浏览器里用
 * chrome.declarativeNetRequest.testMatchOutcome 实测:扩展页/worker 命中,
 * 普通网页与其它扩展不命中。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rulesForBackendUrl, applyFenceRules, FENCE_RULE_ID, FENCE_REMOVED_HEADERS } from '../src/platform/dsh/fence-rules.js'

const EXT = 'kgjjicancjnedmappjhefngdjaommpop'

function conditionOf(backendUrl, options) {
  const rules = rulesForBackendUrl(backendUrl, options)
  assert.equal(rules.length, 1)
  return rules[0].condition
}

test('给了扩展 id 时,规则带上 initiatorDomains 白名单', () => {
  const condition = conditionOf('http://127.0.0.1:3080', { extensionId: EXT })
  assert.deepEqual(condition.initiatorDomains, [EXT],
    '没有白名单,网页的请求也会被摘掉 origin/sec-fetch-site')
})

test('initiatorDomains 与 extensionId 等价,且会去空去重', () => {
  assert.deepEqual(conditionOf('http://127.0.0.1:3080', { initiatorDomains: EXT }).initiatorDomains, [EXT])
  assert.deepEqual(
    conditionOf('http://127.0.0.1:3080', { initiatorDomains: ['  ' + EXT + '  ', EXT, '', '   '] }).initiatorDomains,
    [EXT]
  )
})

test('没有扩展 id 时不写白名单字段(退回旧行为,而不是写空数组)', () => {
  const condition = conditionOf('http://127.0.0.1:3080', {})
  assert.equal('initiatorDomains' in condition, false,
    '空数组会被 Chrome 当成"匹配不到任何发起方",等于把扩展自己也挡了')
  assert.equal(conditionOf('http://127.0.0.1:3080', { extensionId: '   ' }).initiatorDomains, undefined)
})

test('authority 与主机转义保持原样', () => {
  const condition = conditionOf('http://127.0.0.1:3080', { extensionId: EXT })
  assert.equal(condition.regexFilter, '^(?:https?|wss?)://127\\.0\\.0\\.1:3080/')
  assert.deepEqual(condition.resourceTypes, ['xmlhttprequest', 'websocket'])
  // 默认端口折叠成可选端口;非默认端口写死。
  assert.equal(conditionOf('https://host.example.com/', {}).regexFilter, '^(?:https?|wss?)://host\\.example\\.com(?::\\d+)?/')
  assert.equal(conditionOf('http://host.example.com:8642/', {}).regexFilter, '^(?:https?|wss?)://host\\.example\\.com:8642/')
})

test('regexFilter 真的能匹配 ws:// 与 wss://(websocket 声明不作废)', () => {
  const condition = conditionOf('http://127.0.0.1:3080', { extensionId: EXT })
  const regex = new RegExp(condition.regexFilter)
  // WebSocket 的 URL 就是 ws:// / wss://,^https?:// 一个也匹配不到 ——
  // resourceTypes 里写着 websocket 却永远命不中,那条声明等于没写。
  assert.ok(regex.test('http://127.0.0.1:3080/api/x'), 'http 请求仍要命中')
  assert.ok(regex.test('ws://127.0.0.1:3080/api/remote.mux'), 'ws:// 必须命中')
  assert.ok(regex.test('wss://127.0.0.1:3080/api/remote.mux'), 'wss:// 必须命中')
  assert.ok(!regex.test('http://127.0.0.1:9999/api/x'), '别的端口不能被误伤')
})

test('applyFenceRules 自动用 chrome.runtime.id 兜底,并替换掉旧规则', async () => {
  const calls = []
  const dnr = { updateDynamicRules: async (options) => { calls.push(options) } }
  const previous = globalThis.chrome
  globalThis.chrome = { runtime: { id: EXT } }
  try {
    await applyFenceRules(dnr, 'http://127.0.0.1:3080')
  } finally {
    if (previous === undefined) delete globalThis.chrome
    else globalThis.chrome = previous
  }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].removeRuleIds, [FENCE_RULE_ID], '必须先删旧规则再add,否则整批被拒')
  assert.deepEqual(calls[0].addRules[0].condition.initiatorDomains, [EXT],
    '白名单是安全默认值,不能靠调用点记得传')
  assert.deepEqual(calls[0].addRules[0].action.requestHeaders.map((h) => h.header), [...FENCE_REMOVED_HEADERS])
})

test('取不到 chrome.runtime.id 时不写白名单,扩展仍能连上后端', async () => {
  const calls = []
  const dnr = { updateDynamicRules: async (options) => { calls.push(options) } }
  const previous = globalThis.chrome
  delete globalThis.chrome
  try {
    await applyFenceRules(dnr, 'http://127.0.0.1:3080')
  } finally {
    if (previous !== undefined) globalThis.chrome = previous
  }
  assert.equal('initiatorDomains' in calls[0].addRules[0].condition, false)
})
