// Swaps plain-text "Loading…" elements for <LiquidLoader /> across src/.
//
//   node scripts/liquid-loader-codemod.mjs           dry run (prints what would change)
//   node scripts/liquid-loader-codemod.mjs --write   applies the changes
//
// Only touches elements whose ONLY content is text starting with "Loading",
// e.g. <div className="dash-empty-state">Loading…</div>. Everything else
// that mentions "Loading" is listed at the end for manual review.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('src')
const LOADER = path.join(ROOT, 'components', 'common', 'LiquidLoader')
const WRITE = process.argv.includes('--write')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.jsx$/.test(e.name)) out.push(p)
  }
  return out
}

const ELEMENT = /<(div|p|span)(\s[^>]*)?>\s*(Loading[^<>{}]*?)\s*<\/\1>/g

function clean(text) {
  return text.replace(/(…|\.\.\.)\s*$/, '').trim() || 'Loading'
}

function importLine(file) {
  let rel = path.relative(path.dirname(file), LOADER).split(path.sep).join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return `import LiquidLoader from '${rel}'`
}

function addImport(src, file) {
  if (/import\s+LiquidLoader\b/.test(src)) return src
  const re = /^[ \t]*import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm
  let last = null, m
  while ((m = re.exec(src))) last = m
  const line = importLine(file)
  if (!last) return line + '\n' + src
  const end = last.index + last[0].length
  return src.slice(0, end) + '\n' + line + src.slice(end)
}

let changedFiles = 0, changedNodes = 0
const leftovers = []

for (const file of walk(ROOT)) {
  if (file.startsWith(LOADER)) continue
  const original = fs.readFileSync(file, 'utf8')
  let count = 0
  let next = original.replace(ELEMENT, (_all, tag, _attrs, text) => {
    count++
    const label = clean(text).replace(/"/g, '&quot;')
    return tag === 'span'
      ? `<LiquidLoader size="xs" label="${label}" />`
      : `<LiquidLoader variant="block" label="${label}" />`
  })
  if (count) {
    next = addImport(next, file)
    changedFiles++; changedNodes += count
    console.log(`${WRITE ? 'updated' : 'would update'}  ${path.relative(process.cwd(), file)}  (${count})`)
    if (WRITE) fs.writeFileSync(file, next)
  }
  next.split('\n').forEach((line, i) => {
    if (/Loading/.test(line) && !/LiquidLoader/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
      leftovers.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 110)}`)
    }
  })
}

console.log(`\n${changedNodes} element(s) in ${changedFiles} file(s) ${WRITE ? 'changed' : 'would change'}.`)
if (leftovers.length) {
  console.log(`\nStill mention "Loading" — review by hand:\n`)
  leftovers.forEach(l => console.log('  ' + l))
}
if (!WRITE) console.log('\nDry run only. Re-run with --write to apply.')
