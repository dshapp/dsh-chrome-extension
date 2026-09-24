/**
 * Agent 预设的模式说明弹窗(对齐 web ui-agent-preset PresetGuideDialog 与
 * Mac PresetGuideSheet.swift)。
 *
 * 钉住四件事:
 *   1. 只有出厂预设有说明(web presetGuide 只认 trust === "system"),自定义预设没有;
 *   2. 正文按 `### ` 分段、`> ` 是示例任务(Mac GuideSection.parse);
 *   3. 中英两套文案 key 齐全,且与 web guide-locales 同源;
 *   4. 预设页行内的"模式说明 / 如何使用"只开弹窗,不会冒泡成"设为默认"。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

const { t, setLang } = await import('../src/shared/i18n.js')
const { presetGuide, parseGuideSections, renderGuideBody, openPresetGuide } =
  await import('../src/app/sidepanel/settings/preset-guide-sheet.js')
const { createPresetsPane } = await import('../src/app/sidepanel/settings/presets-pane.js')

test('presetGuide:四个出厂预设(含旧名 code)有说明,自定义与未知预设没有', () => {
  assert.deepEqual(presetGuide({ id: 'standard' }), {
    intro: 'pset.guideStandardIntro',
    explanation: 'pset.guideStandardExplanation',
    usage: 'pset.guideStandardUsage'
  })
  assert.equal(presetGuide({ id: 'ptc' }).intro, 'pset.guidePtcIntro')
  assert.equal(presetGuide({ id: 'minimal' }).usage, 'pset.guideMinimalUsage')
  assert.equal(presetGuide({ id: 'cordis' }).explanation, 'pset.guideCordisExplanation')
  assert.equal(presetGuide({ id: 'code' }).intro, 'pset.guidePtcIntro')
  // 声明里自带 name 的同 id 预设是用户的,能力描述归它自己。
  assert.equal(presetGuide({ id: 'standard', name: 'My standard' }), undefined)
  assert.equal(presetGuide({ id: 'standard', trust: 'user' }), undefined)
  assert.equal(presetGuide({ id: 'review' }), undefined)
  assert.equal(presetGuide(null), undefined)
})

test('i18n:每个出厂说明的三段中英都有,且不回退到 key 本身', () => {
  for (const lang of ['en', 'zh']) {
    setLang(lang)
    for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
      const guide = presetGuide({ id })
      for (const key of [guide.intro, guide.explanation, guide.usage]) {
        assert.notEqual(t(key), key, `${lang} 缺 ${key}`)
      }
    }
    for (const key of ['pset.modeExplanation', 'pset.howToUse', 'pset.guideSections', 'pset.guideExampleTask']) {
      assert.notEqual(t(key), key, `${lang} 缺 ${key}`)
    }
  }
  setLang('zh')
  assert.equal(t('pset.modeExplanation'), '模式说明')
  assert.equal(t('pset.howToUse'), '如何使用')
  assert.ok(t('pset.guidePtcExplanation').startsWith('### 怎样调用工具'))
  setLang('en')
  assert.equal(t('pset.modeExplanation'), 'Mode details')
})

test('parseGuideSections:按 ### 分段,> 行是示例任务,其余是段落', () => {
  setLang('en')
  const sections = parseGuideSections(t('pset.guideStandardUsage'))
  assert.deepEqual(sections.map((section) => section.title), ['Fix a bug', 'Organize project notes'])
  assert.equal(sections[0].blocks[0].kind, 'task')
  assert.ok(sections[0].blocks[0].text.startsWith('Find out why'))
  assert.equal(sections[0].blocks[1].kind, 'text')
  assert.ok(sections[0].blocks[1].text.startsWith('Expected output'))
  assert.deepEqual(parseGuideSections(''), [])
  // cordis 的说明页三段,全是段落。
  const cordis = parseGuideSections(t('pset.guideCordisExplanation'))
  assert.equal(cordis.length, 3)
  assert.ok(cordis.every((section) => section.blocks.every((block) => block.kind === 'text')))
})

test('renderGuideBody:初始页可见、另一页 hidden;示例徽标只在使用页', () => {
  setLang('en')
  const host = document.createElement('div')
  host.innerHTML = renderGuideBody(presetGuide({ id: 'ptc' }), 'usage')
  assert.equal(host.querySelector('[data-guide-page="usage"]').hidden, false)
  assert.equal(host.querySelector('[data-guide-page="explanation"]').hidden, true)
  assert.equal(host.querySelector('[data-guide-tab="usage"]').getAttribute('aria-selected'), 'true')
  assert.equal(host.querySelectorAll('[data-guide-page="usage"] .pset-guide-task').length, 2)
  assert.equal(host.querySelectorAll('[data-guide-page="usage"] .set-tag').length, 2)
  assert.equal(host.querySelectorAll('[data-guide-page="explanation"] .set-tag').length, 0)
})

/// 最小 sheet 替身:与 settings-root createSheet 同形(open/close/owns/generation)。
function fakeSheet() {
  const root = document.createElement('div')
  let generation = 0
  let isOpen = false
  return {
    root,
    get isOpen() { return isOpen },
    title: null,
    owns(token) { return token === generation && isOpen },
    open({ title, body, actions, bind }) {
      generation += 1
      isOpen = true
      this.title = title
      root.innerHTML = `<div class="set-sheet-body">${body}</div><div class="set-sheet-actions">${actions}</div>`
      bind?.(root, generation)
      return generation
    },
    close(token) {
      if (token !== undefined && !this.owns(token)) return
      generation += 1
      isOpen = false
      root.innerHTML = ''
    }
  }
}

test('openPresetGuide:切页、复制示例任务、完成关闭', async () => {
  setLang('zh')
  const sheet = fakeSheet()
  const copied = []
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { copied.push(text) } } },
    configurable: true
  })
  openPresetGuide({ sheet, title: '创造模式', guide: presetGuide({ id: 'cordis' }) })
  assert.equal(sheet.title, '创造模式')
  const root = sheet.root
  assert.equal(root.querySelector('[data-guide-page="explanation"]').hidden, false)
  root.querySelector('[data-guide-tab="usage"]').click()
  assert.equal(root.querySelector('[data-guide-page="usage"]').hidden, false)
  assert.equal(root.querySelector('[data-guide-page="explanation"]').hidden, true)
  const copyButton = root.querySelector('[data-guide-page="usage"] [data-copy]')
  copyButton.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(copied.length, 1)
  assert.ok(copied[0].startsWith('帮我写一个 DSH 插件'))
  assert.equal(copyButton.textContent, t('copied'))
  root.querySelector('#pset-guide-done').click()
  assert.equal(sheet.isOpen, false)
})

test('预设页:内置行有两个说明入口,自定义行没有;点入口只开弹窗不设默认', async () => {
  setLang('en')
  const host = document.createElement('div')
  const sheet = fakeSheet()
  const mutations = []
  const settingsService = {
    presetList: async () => ({
      modeSelectionEnabled: true,
      presets: [
        { id: 'standard', isDefault: true, order: 0 },
        { id: 'ptc', order: 1 },
        { id: 'review', name: 'Review', order: 2 }
      ]
    }),
    describe: async () => ({ writable: true, namespaces: [] }),
    mutate: async (...args) => { mutations.push(args) }
  }
  const pane = createPresetsPane({
    host, sheet, settingsService, deps: { formatErrorDetails: String }, showToast: () => {}
  })
  await pane.refresh()
  assert.equal(host.querySelectorAll('#pset-row-standard [data-guide-open]').length, 2)
  assert.equal(host.querySelectorAll('#pset-row-ptc [data-guide-open]').length, 2)
  assert.equal(host.querySelectorAll('#pset-row-review [data-guide-open]').length, 0)
  host.querySelector('#pset-row-ptc [data-guide-open="usage"]').click()
  assert.equal(sheet.isOpen, true)
  assert.equal(sheet.title, 'PTC mode')
  assert.equal(sheet.root.querySelector('[data-guide-page="usage"]').hidden, false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(mutations.length, 0, '说明入口不能冒泡成行点击(设为默认)')
})
