/**
 * install.sh --help 必须列出完整的 "Environment overrides" 清单。
 *
 * usage() 用 `sed -n '3,26p'` 截取文件头的注释块,但环境变量清单的最后一个
 * 条目 DSH_WEB_PORT 在第 27 行 —— 区间少了一行,--help 静默漏掉这个覆盖项,
 * 而安装脚本本身是认它的(WEB_PORT="\${DSH_WEB_PORT:-3080}")。用户按 --help
 * 配端口时会以为不支持。
 *
 * 这里跑真实的 install.sh(而不是复述 sed 区间):它是纯文本截取,--help 在
 * 参数解析第一步就 exit 0,不会产生任何副作用。
 *
 * Run with: node --test 'tests/*.spec.mjs'
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const INSTALL_SH = fileURLToPath(new URL('../install.sh', import.meta.url))

function help() {
  const r = spawnSync('bash', [INSTALL_SH, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0, 'install.sh --help 应当干净地以 0 退出')
  return r.stdout
}

test('--help 列出 DSH_WEB_PORT(最后一个环境变量覆盖项)', () => {
  const out = help()
  assert.match(out, /DSH_WEB_PORT\s+port the installer starts dsh web on/, 'DSH_WEB_PORT 不能被漏掉')
})

test('--help 仍列出所有其它覆盖项,且不越过注释块', () => {
  const out = help()
  for (const name of ['DSH_EXTENSION_ID', 'DSH_REGISTRY', 'DSH_PUBLIC_REGISTRY', 'DSH_HOME', 'DSH_WEB_PORT']) {
    assert.ok(out.includes(name), `--help 必须列出 ${name}`)
  }
  const lines = out.trimEnd().split('\n')
  assert.ok(lines.length <= 25, `--help 不该把注释块尾部/代码一起截进来,实际 ${lines.length} 行`)
  assert.ok(!out.includes('====='), '分隔线属于注释块边界,不该出现在 --help 里')
  assert.ok(!out.includes('set -euo pipefail'), '不能越过注释块把脚本代码打出来')
})
