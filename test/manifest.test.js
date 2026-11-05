'use strict'
// The manifest and source checks the design asks for: the services it uses and collects (the app's
// validate.ts refuses a collected name missing from uses), no npm dependency, no exec, no network,
// no secrets or OAuth (Inbox has no account), example data only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const walkFiles = (dirs, ext) => {
  const out = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (ext.some((e) => n.name.endsWith(e))) out.push(p)
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d))
  return out
}
const sources = () => walkFiles(['dist', 'panels', 'settings'], ['.js'])
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the manifest: id, api, entry points exist, the CLI, the panel with the agenda slot, the settings page', () => {
  assert.equal(manifest.id, 'bronos.inbox')
  assert.equal(manifest.version, '0.2.1')
  assert.equal(manifest.api, 1)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author, 'Oleg Bronzov')
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)))
  const [panel] = manifest.contributes.panels
  assert.equal(panel.id, 'main')
  assert.equal(panel.defaultZone, 'right')
  assert.ok(fs.existsSync(path.join(ROOT, panel.entry)))
  assert.ok(fs.existsSync(path.join(ROOT, panel.icon)))
  assert.deepEqual(panel.slots, ['agenda'])
  assert.equal(manifest.contributes.slots, undefined, 'Inbox places the agenda slot, Calendar provides it')
  assert.deepEqual(manifest.contributes.cli.map((c) => c.name), ['inbox'])
  // Only `-` arguments read stdin (`rules import -`, `<json|->`): with stdinDash the app reads it
  // for those alone, so `ccc inbox list` from a script never waits on an inherited open stdin.
  const [cli] = manifest.contributes.cli
  assert.equal(cli.stdin, true)
  assert.equal(cli.stdinDash, true)
  assert.ok(cli.summary.length <= 200 && cli.usage.length <= 500 && cli.usage.startsWith('inbox '), 'the app caps summary at 200 and usage at 500 characters')
  assert.match(manifest.description, /cc-cockpit 0\.10\.0/)
  const page = manifest.contributes.settings.page
  assert.deepEqual(page, { entry: 'settings/index.html', scopes: ['app', 'project'] })
  assert.ok(fs.existsSync(path.join(ROOT, page.entry)))
  assert.equal(manifest.contributes.settings.app, undefined, 'no schema form: the rules editor is the page')
})

test('services: uses inbox-feed 2 and jev 1 (no calendar), collects inbox-feed (a subset of uses), provides nothing', () => {
  assert.deepEqual(manifest.services.uses, { 'inbox-feed': 2, jev: 1 })
  assert.deepEqual(manifest.services.collects, ['inbox-feed'])
  for (const name of manifest.services.collects) assert.ok(Object.hasOwn(manifest.services.uses, name), name)
  assert.equal(manifest.services.provides, undefined)
})

test('no dependency, no exec, no network, no secrets or OAuth', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies, undefined)
  for (const file of sources()) {
    const src = noComments(fs.readFileSync(file, 'utf8'))
    assert.doesNotMatch(src, /require\(['"](node:)?child_process['"]\)|ctx\.exec\(/, file)
    assert.doesNotMatch(src, /\bfetch\(|https?\.request\(/, file)
    assert.doesNotMatch(src, /ctx\.(secrets|oauth)\b/, file)
  }
})

test('example data only: no address outside example domains in the sources and tests', () => {
  for (const file of [...sources(), ...walkFiles(['test'], ['.js']), path.join(ROOT, 'README.md')]) {
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      assert.match(m[1], /(^|\.)example\.(com|org)$|^anthropic\.com$|^gmail\.com$/, `${file}: ${m[0]}`)
    }
  }
})
