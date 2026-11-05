'use strict'
// `ccc inbox rules` and `ccc inbox groups` (dist/lib/rulescli.js through dist/host.js): every command's
// happy path, a refused edit storing nothing, the scope rule (the set in effect, --global, --project
// refused without a set of its own), the export/import round trip and the test dry run.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createInbox } = require('../dist/host')
const S = require('../dist/lib/settings')
const C = require('../dist/lib/cli')
const RC = require('../dist/lib/rulescli')
const { fakeCtx, fakeFeedV2, fakeJev, fakeAppStorage, item2, NOW, HOUR, CHAT, MAIL } = require('./fakes')

const LEAD = { group: 'now', when: [{ field: 'from.address', op: 'endsWith', value: '@example.com' }] }
const lead = (o = {}) => JSON.stringify({ ...LEAD, ...o })

function setup(o = {}) {
  const ctx = fakeCtx({ appStorage: o.appStorage, jev: o.jev })
  ctx.addProvider('bronos.chat', fakeFeedV2(CHAT, [item2('c1', { title: 'Lunch?', time: NOW - 4 * 60000 })]))
  ctx.addProvider(
    'bronos.mail',
    fakeFeedV2(MAIL, [
      item2('m1', { title: 'Plan for Q4', time: NOW - HOUR, extra: { from: { name: 'Ann Example', address: 'ann@example.com' } } }),
      item2('m2', { title: 'Your receipt', time: NOW - 2 * HOUR, extra: { from: { name: 'Shop', address: 'shop@example.org' } } }),
    ])
  )
  return ctx
}
const start = async (ctx) => {
  const inbox = createInbox(ctx, { now: () => NOW, callMs: 200 })
  await inbox.first
  return inbox
}
/** A project set of its own: the defaults with a Boss group in front. */
const ownSet = () => {
  const d = S.defaults()
  return { ...d, groups: [{ id: 'boss', name: 'Boss', collapsed: false, badge: true }, ...d.groups], rules: [{ id: 'b', enabled: true, group: 'boss', when: [{ field: 'title', op: 'contains', value: 'plan' }] }, ...d.rules] }
}

test('rules: the global set with its groups, numbered rules and agenda, named as the set in effect', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const r = await ctx.runCli(['rules'])
  assert.equal(r.code ?? 0, 0)
  assert.deepEqual(r.stdout.split('\n'), [
    'Inbox global rules (this project uses the global set)',
    '',
    'Groups, in order:',
    '  1. Now [id now] (badge)',
    '  2. Chat [id chat] (badge)',
    '  3. Mail [id mail] (badge)',
    '  4. Jira [id jira] (badge)',
    '  5. Rest [id rest] (built in, always last, collapsed)',
    '',
    'Rules: the first enabled rule that holds places an item; when none holds it goes to Rest.',
    '  1. on: read is true → Rest [id read]',
    '  2. on: sourceKind is chat and mentionsMe is true → Now [id chat-mention]',
    '  3. on: sourceKind is chat and to is direct → Now [id chat-direct]',
    '  4. on: sourceKind is chat → Chat [id chat]',
    '  5. on: sourceKind is mail → Mail [id mail]',
    '  6. on: sourceKind is issues → Jira [id jira]',
    '',
    'Agenda: top',
    '',
  ])
  assert.equal((await ctx.runCli(['rules', 'list'])).stdout, r.stdout)
  assert.equal((await ctx.runCli(['groups'])).stdout, r.stdout)
  assert.equal((await ctx.runCli(['rules', '--global'])).stdout, r.stdout)
  inbox.dispose()
})

test('rules: names, Jev questions and disabled rules read as the page and why phrase them, one clean line each', async () => {
  const ctx = setup()
  const d = S.defaults()
  d.rules.unshift({ id: 'j', name: 'Urgent\nmail', enabled: false, group: 'now', when: [{ field: 'sourceKind', op: 'in', value: ['mail', 'chat'] }], jev: { question: 'Is this urgent?', min: 0.8 } })
  await ctx.appStorage.set(S.KEY, d)
  const inbox = await start(ctx)
  const out = (await ctx.runCli(['rules'])).stdout
  assert.ok(out.includes('  1. off: "Urgent mail": sourceKind in mail, chat and Jev "Is this urgent?" >= 0.8 → Now [id j]\n'), out)
  inbox.dispose()
})

test('scope: a project with its own set lists and edits that set; --global edits the global set, which does not apply here', async () => {
  const ctx = setup()
  await ctx.storage.set(S.KEY, ownSet())
  const inbox = await start(ctx)
  assert.equal(inbox.settingsSet(), 'project')
  assert.match((await ctx.runCli(['rules'])).stdout, /^Inbox this project's rules \(its own set; the global rules do not apply here\)\n/)
  assert.match((await ctx.runCli(['rules', '--project'])).stdout, /^Inbox this project's rules/)
  assert.match((await ctx.runCli(['rules', '--global'])).stdout, /^Inbox global rules \(not in effect here: this project has its own set\)\n/)

  let r = await ctx.runCli(['rules', 'disable', '1'])
  assert.equal(r.stdout, "Disabled rule 1. off: title contains plan → Boss [id b]\nSaved to this project's rules; applied now.\n")
  assert.equal((await ctx.storage.get(S.KEY)).rules[0].enabled, false)
  assert.equal(await ctx.appStorage.get(S.KEY), undefined, 'the global set untouched')
  assert.equal(inbox.settings().rules[0].enabled, false, 'applied in this window')

  r = await ctx.runCli(['rules', 'rm', '1', '--global'])
  assert.equal(r.stdout, 'Removed rule 1. on: read is true → Rest [id read]\nSaved to the global rules (not in effect here: this project has its own set); applied now.\n')
  assert.deepEqual((await ctx.appStorage.get(S.KEY)).rules.map((x) => x.id), ['chat-mention', 'chat-direct', 'chat', 'mail', 'jira'])
  assert.equal(inbox.settings().rules[0].id, 'b', 'the project set still in effect')
  inbox.dispose()
})

test('scope: --project in a project on the global rules is refused, for a read and for every edit, and stores nothing', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const refusal = 'This project uses the global rules; make it its own in Settings › This Project, or use --global.\n'
  for (const argv of [['rules'], ['rules', 'export'], ['rules', 'add', lead()], ['rules', 'disable', '1'], ['groups', 'add', 'X'], ['rules', 'test', '1'], ['rules', 'import']]) {
    const r = await ctx.runCli([...argv, '--project'], JSON.stringify(S.defaults()))
    assert.deepEqual(r, { stderr: refusal, code: 1 }, argv.join(' '))
  }
  assert.equal(await ctx.storage.get(S.KEY), undefined, 'no project set made')
  assert.equal(await ctx.appStorage.get(S.KEY), undefined, 'nor a global save')
  assert.equal(inbox.settingsSet(), 'global')
  inbox.dispose()
})

test('scope: with no flag a project on the global rules edits the global set, and another window reads it like a page save', async () => {
  const shared = fakeAppStorage()
  const a = setup({ appStorage: shared })
  const b = setup({ appStorage: shared })
  const ia = await start(a)
  const ib = await start(b)
  const r = await a.runCli(['rules', 'add', lead()])
  assert.equal(r.stdout, 'Added rule 2. on: from.address endsWith @example.com → Now [id r1]\nSaved to the global rules; applied now.\n')
  assert.equal(b.storage.map.size + a.storage.map.size, 0, 'no project set')
  await ib.tick()
  assert.deepEqual(ib.settings().rules[1], { id: 'r1', enabled: true, group: 'now', when: LEAD.when })
  ia.dispose()
  ib.dispose()
})

test('rules add: after the leading Rest rules by default, --at, ids minted or kept, applied at once (items placed again)', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  assert.match((await ctx.runCli([])).stdout, /Plan for Q4.*\n {5}rule 5: sourceKind is mail/)
  await ctx.runCli(['rules', 'add', lead()])
  assert.deepEqual(inbox.settings().rules.map((x) => x.id), ['read', 'r1', 'chat-mention', 'chat-direct', 'chat', 'mail', 'jira'])
  assert.match((await ctx.runCli([])).stdout, /Now \(1\)\n.*Plan for Q4.*\n {5}rule 2: from\.address endsWith @example\.com/)

  let r = await ctx.runCli(['rules', 'add', lead({ id: 'mine', group: 'rest' }), '--at', '8'])
  assert.match(r.stdout, /^Added rule 8\. on: from\.address endsWith @example\.com → Rest \[id mine\]\n/)
  r = await ctx.runCli(['rules', 'add', lead({ enabled: false }), '--at', '1'])
  assert.match(r.stdout, /^Added rule 1\. off: .* \[id r2\]\n/)
  assert.deepEqual((await ctx.appStorage.get(S.KEY)).rules.map((x) => x.id), ['r2', 'read', 'r1', 'chat-mention', 'chat-direct', 'chat', 'mail', 'jira', 'mine'])

  // Every rule to Rest: the new one goes last.
  assert.equal(RC.defaultAt({ rules: [{ group: 'rest' }, { group: 'rest' }] }), 3)
  assert.equal(RC.defaultAt({ rules: [] }), 1)
  r = await ctx.runCli(['rules', 'add', lead(), '--at', '11'])
  assert.deepEqual(r, { stderr: 'rules add: --at 11: a new rule goes at 1 to 10\n', code: 1 })
  inbox.dispose()
})

test('rules add: the rule may come on stdin with -; bad JSON, no JSON or a non-object is refused', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  assert.match((await ctx.runCli(['rules', 'add', '-'], lead())).stdout, /^Added rule 2\./)
  let r = await ctx.runCli(['rules', 'add', '-'], '')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^rules add: no rule on stdin: pipe the JSON in/)
  r = await ctx.runCli(['rules', 'add', '{"group":'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^rules add: the rule is not JSON: /)
  r = await ctx.runCli(['rules', 'add', '[1]'])
  assert.match(r.stderr, /^rules add: a rule is a JSON object/)
  assert.equal(inbox.settings().rules.length, 7)
  inbox.dispose()
})

test('a refused edit stores nothing and names the place, as a JSON path and by position', async () => {
  const ctx = setup()
  await ctx.appStorage.set(S.KEY, S.defaults())
  const inbox = await start(ctx)
  const before = await ctx.appStorage.get(S.KEY)
  const cases = [
    [['rules', 'add', lead({ when: [{ field: 'labels', op: 'is', value: 'x' }] })], 'Nothing stored: rules[1].when[0].op: rule 2, condition 1: labels takes has, hasNot, hasPrefix, not "is"\n'],
    [['rules', 'add', lead({ group: 'Now' })], 'Nothing stored: rules[1].group: rule 2 goes to a group that is not there ("Now")\n'],
    [['rules', 'add', lead({ id: 'read' })], 'Nothing stored: rules[1].id: rule 2: the id "read" is used twice\n'],
    [['rules', 'add', lead({ when: [], jev: { question: 'Urgent?', min: 2 } })], 'Nothing stored: rules[1].jev.min: rule 2: the Jev threshold must be a number from 0 to 1\n'],
    [['rules', 'set', '3', '{"group":"now"}'], 'Nothing stored: rules[2]: rule 3 needs a condition or a Jev question\n'],
    [['rules', 'set', '1', lead({ when: [{ field: 'time', op: 'newerThan', value: 1.5 }] })], 'Nothing stored: rules[0].when[0].value: rule 1, condition 1: time newerThan needs a whole number of minutes from 1 to 525600\n'],
    [['groups', 'add', 'x'.repeat(41)], 'Nothing stored: groups[4].name: group 5 needs a name of 1 to 40 characters\n'],
    [['groups', 'rename', 'now', ' '], 'Nothing stored: groups[0].name: group 1 needs a name of 1 to 40 characters\n'],
  ]
  for (const [argv, stderr] of cases) assert.deepEqual(await ctx.runCli(argv), { stderr, code: 1 }, argv.join(' '))
  assert.deepEqual(await ctx.appStorage.get(S.KEY), before)
  assert.deepEqual(inbox.settings(), S.defaults())
  inbox.dispose()
})

test('rules set, rm, move, enable, disable', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  let r = await ctx.runCli(['rules', 'set', '5', JSON.stringify({ group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }] })])
  assert.equal(r.stdout, 'Replaced rule 5. on: sourceKind is mail → Now [id mail]\nSaved to the global rules; applied now.\n')
  await ctx.runCli(['rules', 'disable', '5'])
  r = await ctx.runCli(['rules', 'set', '5', '-'], JSON.stringify({ name: 'Mail', group: 'mail', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }] }))
  assert.match(r.stdout, /^Replaced rule 5\. off: "Mail": sourceKind is mail → Mail \[id mail\]\n/, 'id and off kept')
  r = await ctx.runCli(['rules', 'set', '5', lead({ id: 'new', enabled: true })])
  assert.match(r.stdout, /^Replaced rule 5\. on: .* \[id new\]\n/, 'given ones win')
  r = await ctx.runCli(['rules', 'enable', '1'])
  assert.match(r.stdout, /^Enabled rule 1\. on: read is true/)
  r = await ctx.runCli(['rules', 'move', '1', '6'])
  assert.match(r.stdout, /^Moved rule 1 to 6\. on: read is true → Rest \[id read\]\n/)
  assert.deepEqual(inbox.settings().rules.map((x) => x.id), ['chat-mention', 'chat-direct', 'chat', 'new', 'jira', 'read'])
  r = await ctx.runCli(['rules', 'rm', '6'])
  assert.equal(r.stdout, 'Removed rule 6. on: read is true → Rest [id read]\nSaved to the global rules; applied now.\n')
  assert.equal(inbox.settings().rules.length, 5)
  for (const argv of [['rules', 'rm', '6'], ['rules', 'enable', '9'], ['rules', 'set', '7', lead()], ['rules', 'move', '7', '1']]) {
    r = await ctx.runCli(argv)
    assert.equal(r.code, 1, argv.join(' '))
    assert.match(r.stderr, /no rule 7|no rule 6|no rule 9/)
  }
  assert.deepEqual(await ctx.runCli(['rules', 'move', '1', '6']), { stderr: 'rules move: cannot move to 6: the set has 5 rules\n', code: 1 })
  inbox.dispose()
})

test('groups add, rename, move, rm (its rules go to Rest, as on the page); Rest cannot go or move', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  let r = await ctx.runCli(['groups', 'add', 'Lead', 'and', 'boss', '--badge'])
  assert.equal(r.stdout, 'Added group 5. Lead and boss [id g1] (badge)\nSaved to the global rules; applied now.\n')
  r = await ctx.runCli(['groups', 'add', 'Later', '--collapsed', '--at', '1'])
  assert.equal(r.stdout, 'Added group 1. Later [id g2] (collapsed)\nSaved to the global rules; applied now.\n')
  assert.deepEqual(await ctx.runCli(['groups', 'add', 'X', '--at', '8']), { stderr: 'groups add: --at 8: a new group goes at 1 to 7 (Rest stays last)\n', code: 1 })
  r = await ctx.runCli(['groups', 'rename', 'g1', 'Lead'])
  assert.equal(r.stdout, 'Renamed group 6. Lead [id g1] (badge)\nSaved to the global rules; applied now.\n')
  r = await ctx.runCli(['groups', 'rename', '7', 'Everything', 'else'])
  assert.match(r.stdout, /^Renamed group 7\. Everything else \[id rest\]/)
  r = await ctx.runCli(['groups', 'move', 'g1', '1'])
  assert.match(r.stdout, /^Moved group 1\. Lead \[id g1\]/)
  assert.deepEqual(inbox.settings().groups.map((g) => g.id), ['g1', 'g2', 'now', 'chat', 'mail', 'jira', 'rest'])
  r = await ctx.runCli(['groups', 'rm', 'now'])
  assert.equal(r.stdout, 'Removed group 3. Now [id now] (badge); its 2 rules now go to Rest\nSaved to the global rules; applied now.\n')
  assert.deepEqual(inbox.settings().rules.filter((x) => x.group === 'rest').map((x) => x.id), ['read', 'chat-mention', 'chat-direct'])
  assert.deepEqual(await ctx.runCli(['groups', 'rm', 'rest']), { stderr: 'groups rm: Rest is built in and cannot be removed (rename it instead)\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['groups', 'move', '6', '1']), { stderr: 'groups move: Rest is built in and stays last\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['groups', 'move', 'g1', '6']), { stderr: 'groups move: cannot move to 6: groups go at 1 to 5 (Rest stays last)\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['groups', 'rm', 'nope']), { stderr: 'groups rm: no group with the id "nope" (ccc inbox rules lists them)\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['groups', 'rm', '9']), { stderr: 'groups rm: no group 9: the set has 6\n', code: 1 })
  inbox.dispose()
})

test('export and import: a round trip stores the same set; missing ids are minted, given ones kept', async () => {
  const ctx = setup()
  await ctx.storage.set(S.KEY, ownSet())
  const inbox = await start(ctx)
  const out = (await ctx.runCli(['rules', 'export'])).stdout
  assert.deepEqual(JSON.parse(out), ownSet())
  let r = await ctx.runCli(['rules', 'import'], out)
  assert.equal(r.stdout, "Imported: 6 groups, 7 rules, agenda top\nSaved to this project's rules; applied now.\n")
  assert.deepEqual(await ctx.storage.get(S.KEY), ownSet())
  assert.equal((await ctx.runCli(['rules', 'export', '--project'])).stdout, out)

  const next = { version: 2, agenda: 'off', groups: [{ name: 'Mine' }, { id: 'g1', name: 'Taken' }, { id: 'rest', name: 'Rest' }], rules: [{ group: 'g2', when: [{ field: 'read', op: 'is', value: false }] }, { id: 'keep', group: 'rest', jev: { question: 'Spam?', min: 0.5 } }] }
  r = await ctx.runCli(['rules', 'import', '-'], JSON.stringify(next))
  assert.equal(r.stdout, "Imported: 3 groups, 2 rules, agenda off (2 ids minted)\nSaved to this project's rules; applied now.\n")
  const saved = await ctx.storage.get(S.KEY)
  assert.deepEqual(saved.groups.map((g) => g.id), ['g2', 'g1', 'rest'])
  assert.deepEqual(saved.rules.map((x) => [x.id, x.group, x.enabled]), [['r1', 'g2', true], ['keep', 'rest', true]])
  assert.equal(inbox.settings().agenda, 'off')
  inbox.dispose()
})

test('import: a set with any problem, not JSON or nothing on stdin stores nothing', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const d = S.defaults()
  const bad = { ...d, rules: [...d.rules, { group: 'now', when: [{ field: 'labels', op: 'has', value: 'a' }, { field: 'to', op: 'in', value: ['direct', 'dm'] }] }] }
  assert.deepEqual(await ctx.runCli(['rules', 'import'], JSON.stringify(bad)), {
    stderr: 'Nothing stored: rules[6].when[1].value: rule 7, condition 2: to in needs a list of 1 to 50 values, each one of direct, group, cc, none\n',
    code: 1,
  })
  assert.deepEqual(await ctx.runCli(['rules', 'import'], JSON.stringify({ ...d, version: undefined })), { stderr: 'Nothing stored: version: these are not Inbox v2 settings (version 2)\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['rules', 'import'], JSON.stringify({ ...d, groups: d.groups.slice(0, 4) })), { stderr: 'Nothing stored: groups: the Rest group is missing\n', code: 1 })
  let r = await ctx.runCli(['rules', 'import'], '{"version": 2,')
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^rules import: the set is not JSON: /)
  r = await ctx.runCli(['rules', 'import'], '')
  assert.match(r.stderr, /^rules import: no set on stdin/)
  assert.equal(await ctx.appStorage.get(S.KEY), undefined)
  assert.deepEqual(await ctx.runCli(['rules', 'import', 'file.json']), { stderr: `rules import reads the JSON from stdin and takes no other argument\nUsage: ${RC.USAGE_RULES}\n(ccc inbox help for details)\n`, code: 2 })
  inbox.dispose()
})

test('export: bounded; a set too large for one output is refused, never cut', () => {
  const big = S.defaults()
  big.rules = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, enabled: true, group: 'rest', when: Array.from({ length: 20 }, () => ({ field: 'title', op: 'contains', value: 'x'.repeat(200) })) }))
  const e = RC.exportText(big)
  assert.match(e.error, /^the set is too large for one output \(\d+ KiB, the limit is 250 KiB\)$/)
  assert.ok(JSON.stringify(RC.exportText(S.defaults()).stdout).length <= RC.MAX_EXPORT)
})

test('rules test: a dry run over this window\'s items, a new rule where add would put it or an existing one; nothing stored', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  let r = await ctx.runCli(['rules', 'test', lead()])
  assert.deepEqual(r.stdout.split('\n'), [
    'Test of a new rule at 2 in the global rules (this project uses the global set); nothing is stored:',
    '  2. on: from.address endsWith @example.com → Now [id r1]',
    'Would place 1 of the 3 items in this window.',
    '  [MAIL] Plan for Q4 (Mail) bronos.mail:m1',
    '',
  ])
  r = await ctx.runCli(['rules', 'test', '-', '--at', '7'], JSON.stringify({ group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }] }))
  assert.match(r.stdout, /\nWould place 0 of the 3 items in this window \(holds for 2; 2 placed by an earlier rule first\)\.\n$/)
  r = await ctx.runCli(['rules', 'test', '5'])
  assert.match(r.stdout, /^Test of rule 5 in the global rules .*\n {2}5\. on: sourceKind is mail → Mail \[id mail\]\nWould place 2 of the 3 items in this window\.\n {2}\[MAIL\] Plan for Q4 \(Mail\) bronos\.mail:m1\n {2}\[MAIL\] Your receipt \(Mail\) bronos\.mail:m2\n$/)
  await ctx.runCli(['rules', 'disable', '4'])
  r = await ctx.runCli(['rules', 'test', '4'])
  assert.match(r.stdout, /\[id chat\] \(disabled: tried as if enabled\)\nWould place 1 of the 3/)
  assert.deepEqual(await ctx.runCli(['rules', 'test', lead({ group: 'nowhere' })]), { stderr: 'test: rules[1].group: rule 2 goes to a group that is not there ("nowhere")\n', code: 1 })
  assert.deepEqual(await ctx.runCli(['rules', 'test', '9']), { stderr: 'test: no rule 9: the set has 6\n', code: 1 })
  assert.equal(inbox.settings().rules.length, 6, 'a test adds nothing')
  assert.equal(inbox.settings().rules[3].enabled, false)
  inbox.dispose()
})

test('rules test: a Jev rule uses cached answers only and says so; no Jev request is made', async () => {
  const jev = fakeJev(() => 0.9)
  const ctx = setup({ jev })
  const inbox = await start(ctx)
  const r = await ctx.runCli(['rules', 'test', JSON.stringify({ group: 'now', when: [{ field: 'sourceKind', op: 'is', value: 'mail' }], jev: { question: 'Is this urgent?', min: 0.8 } })])
  assert.match(r.stdout, /\nWould place 0 of the 3 items in this window\.\nJev: cached answers only \(a test never asks Jev\); 2 items have no answer yet and are not counted\.\n$/)
  assert.equal(jev.calls.length, 0)
  ctx.jev = null
  const r2 = await ctx.runCli(['rules', 'test', JSON.stringify({ group: 'now', jev: { question: 'Is this urgent?', min: 0.8 } })])
  assert.match(r2.stdout, /\nJev: no jev provider is enabled, so this rule places nothing for now \(a test uses cached answers only\)\.\n$/)
  inbox.dispose()
})

test('rules test: lists at most 20 items, then a count', async () => {
  const ctx = fakeCtx()
  ctx.addProvider('bronos.mail', fakeFeedV2(MAIL, Array.from({ length: 25 }, (_, i) => item2(`m${i}`, { title: `M${i}`, time: NOW - i * 60000 }))))
  const inbox = await start(ctx)
  const lines = (await ctx.runCli(['rules', 'test', '5'])).stdout.trimEnd().split('\n')
  assert.equal(lines.length, 3 + 20 + 1)
  assert.equal(lines.at(-1), '  … and 5 more')
  inbox.dispose()
})

test('edits run one at a time: two adds at once both stay', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const [a, b] = await Promise.all([ctx.runCli(['rules', 'add', lead({ id: 'one' })]), ctx.runCli(['rules', 'add', lead({ id: 'two' })])])
  assert.equal((a.code ?? 0) + (b.code ?? 0), 0)
  assert.deepEqual((await ctx.appStorage.get(S.KEY)).rules.slice(1, 3).map((x) => x.id).sort(), ['one', 'two'])
  inbox.dispose()
})

test('a command cancelled by the app (the 30 s limit, Ctrl+C) stores nothing', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const ac = new AbortController()
  ac.abort()
  assert.deepEqual(await ctx.runCli(['rules', 'add', lead()], '', ac.signal), { stderr: 'Nothing stored: the command was cancelled.\n', code: 1 })
  assert.equal(await ctx.appStorage.get(S.KEY), undefined)
  inbox.dispose()
})

test('usage errors exit 2 with the usage line', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  const cases = [
    [['rules', 'frob'], 'unknown rules command "frob"'],
    [['rules', '--global', '--project'], 'use --global or --project, not both'],
    [['rules', 'rm', '1', '--at', '2'], 'rules rm takes no --at'],
    [['rules', 'rm'], 'rules rm needs a rule number'],
    [['rules', 'rm', 'x'], 'rules rm: "x" is not a position (1, 2, ...)'],
    [['rules', 'rm', '0'], 'rules rm: "0" is not a position (1, 2, ...)'],
    [['rules', 'add'], 'rules add needs JSON (one quoted argument, or - to read it from stdin)'],
    [['rules', 'add', '{"group":', '"now"}'], 'rules add: pass the JSON as one quoted argument, or - and pipe it on stdin'],
    [['rules', 'add', '-', '--at'], '--at needs a position (1, 2, ...)'],
    [['rules', 'move', '1'], 'rules move needs a rule number'],
    [['rules', 'test', '2', '--at', '1'], 'rules test <n> tests rule n where it stands: --at is for a new rule'],
    [['rules', 'list', '--badge'], 'rules list takes no --badge'],
    [['rules', '--frob'], 'unknown option --frob'],
  ]
  for (const [argv, m] of cases) assert.deepEqual(await ctx.runCli(argv), { stderr: `${m}\nUsage: ${RC.USAGE_RULES}\n(ccc inbox help for details)\n`, code: 2 }, argv.join(' '))
  const g = await ctx.runCli(['groups', 'rename', 'now'])
  assert.deepEqual(g, { stderr: `groups rename needs a name\nUsage: ${RC.USAGE_GROUPS}\n(ccc inbox help for details)\n`, code: 2 })
  assert.equal(await ctx.appStorage.get(S.KEY), undefined)
  inbox.dispose()
})

test('help: ccc inbox help, rules help and groups help list every rules and groups command', async () => {
  const ctx = setup()
  const inbox = await start(ctx)
  for (const argv of [['help'], ['rules', 'help'], ['groups', '--help']]) assert.equal((await ctx.runCli(argv)).stdout, C.HELP)
  for (const sub of ['export', 'import', 'add <json|->', 'set <n> <json|->', 'rm <n>', 'move <n> <to>', 'enable <n>', 'disable <n>', 'test <json|-|n>']) {
    assert.ok(C.HELP.includes(`ccc inbox rules ${sub}`), sub)
  }
  for (const sub of ['add <name>', 'rename <id|n> <name>', 'rm <id|n>', 'move <id|n> <to>']) assert.ok(C.HELP.includes(`ccc inbox groups ${sub}`), sub)
  for (const w of ['--global', '--project', '--at <n>', '--badge', '--collapsed', 'Settings › This Project']) assert.ok(C.HELP.includes(w), w)
  inbox.dispose()
})
