// 文档正文读取。
//
// `doc` 检查要断言「文档确实这么写」,所以读的是站点 HTML 的**可见文本**,
// 不是源码标记 —— 文档改用 <code> 包裹同一个词,可见文本不变,断言仍应通过。
// 读原始 HTML 会让断言锚在排版上,而排版不是被验证的主张。
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SITE_DIR = join(HERE, '..', '..', 'site')

const cache = new Map()

/** 站点里有哪些页面文件。 */
export const PAGES = [
  { id: 'zh', file: 'index.html' },
  { id: 'en', file: 'index.en.html' },
]

/**
 * 抽出可见文本:去 script/style、去标签、把实体还原。
 * HTML 实体还原只覆盖文档实际用到的那几种 —— 够用即可,不做通用解码器。
 */
export function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

function load(page) {
  if (cache.has(page.id)) return cache.get(page.id)
  const file = join(SITE_DIR, page.file)
  const text = visibleText(readFileSync(file, 'utf8'))
  cache.set(page.id, text)
  return text
}

/** 双站可见文本:{ zh, en }。 */
export function docText() {
  const out = {}
  for (const p of PAGES) out[p.id] = load(p)
  return out
}

/** reference 目录的原文(未剥标签),供结构性断言使用。 */
export function referenceText(name) {
  const key = `ref:${name}`
  if (cache.has(key)) return cache.get(key)
  const text = readFileSync(
    join(HERE, '..', '..', 'skills', 'mcode-docs', 'reference', name),
    'utf8',
  )
  cache.set(key, text)
  return text
}

/** reference 目录全量载入,键为文件名。主进程只调一次,供 ctx.refs 使用。 */
export function loadReferences() {
  const dir = join(HERE, '..', '..', 'skills', 'mcode-docs', 'reference')
  const out = {}
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.md')) out[name] = referenceText(name)
  }
  return out
}
