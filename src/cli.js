#!/usr/bin/env node
// mcp-lock: a lockfile for MCP servers.
//
//   mcp-lock lock    [--config .mcp.json] [--lockfile mcp.lock.json] [--only name,name]
//   mcp-lock check   [--config .mcp.json] [--lockfile mcp.lock.json] [--fail-on high|medium|low|none] [--json]
//   mcp-lock audit   [--config .mcp.json] [--only name] [--json]
//
// lock   connects to every server in the config, records what each exposes, writes the lockfile.
// check  does the same and compares with the lockfile: exits 1 if anything was added, removed or
//        changed, or if a finding at/above --fail-on severity is present (default: high).
// audit  only lints descriptions for hidden instructions; writes nothing.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { snapshotServer } from './snapshot.js'
import { diffServer } from './diff.js'
import { lintItem, SEVERITY_RANK } from './lint.js'

const USAGE = `mcp-lock: a lockfile for MCP servers

Usage:
  mcp-lock lock   [--config .mcp.json] [--lockfile mcp.lock.json] [--only a,b]
  mcp-lock check  [--config .mcp.json] [--lockfile mcp.lock.json] [--fail-on high] [--json]
  mcp-lock audit  [--config .mcp.json] [--only a,b] [--json]

The config uses the .mcp.json format of Claude Code, Cursor and Claude Desktop:
  { "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }
  { "mcpServers": { "name": { "url": "https://example.com/mcp" } } }`

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const opts = { cmd, config: '.mcp.json', lockfile: 'mcp.lock.json', failOn: 'high', json: false, only: null }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--config') opts.config = rest[++i]
    else if (a === '--lockfile') opts.lockfile = rest[++i]
    else if (a === '--fail-on') opts.failOn = rest[++i]
    else if (a === '--only') opts.only = new Set(rest[++i].split(','))
    else if (a === '--json') opts.json = true
    else if (a === '-h' || a === '--help') opts.cmd = 'help'
    else throw new Error(`Unknown option: ${a}`)
  }
  return opts
}

async function loadServers(path, only) {
  if (!existsSync(path)) throw new Error(`Config not found: ${path}`)
  const cfg = JSON.parse(await readFile(path, 'utf8'))
  const servers = cfg.mcpServers ?? cfg.servers ?? {}
  const entries = Object.entries(servers).filter(([name, s]) => (!only || only.has(name)) && !s.disabled)
  if (entries.length === 0) throw new Error(`No MCP servers found in ${path}`)
  return entries
}

async function snapshotAll(entries) {
  const results = {}
  for (const [name, server] of entries) {
    process.stderr.write(`  connecting to ${name}... `)
    try {
      results[name] = await snapshotServer(server)
      const s = results[name]
      process.stderr.write(`${Object.keys(s.tools).length} tools, ${Object.keys(s.prompts).length} prompts, ${Object.keys(s.resources).length} resources\n`)
    } catch (err) {
      process.stderr.write('failed\n')
      results[name] = { error: String(err?.message ?? err) }
    }
  }
  return results
}

function lintSnapshot(snap) {
  const findings = []
  for (const kind of ['tools', 'prompts', 'resources']) {
    for (const [key, { item }] of Object.entries(snap[kind] ?? {})) {
      for (const f of lintItem(item)) findings.push({ kind, key, ...f })
    }
  }
  if (snap.instructions) for (const f of lintItem({ description: snap.instructions })) findings.push({ kind: 'server', key: 'instructions', ...f })
  return findings
}

const ICON = { high: '✖', medium: '▲', low: '·', added: '+', removed: '-', changed: '~' }

function printFindings(name, findings) {
  for (const f of findings) {
    console.log(`  ${ICON[f.severity]} [${f.severity}] ${f.rule} in ${f.kind}/${f.key}: ${f.why}`)
    console.log(`      "${f.excerpt}"`)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.cmd || opts.cmd === 'help') return console.log(USAGE)
  if (!['lock', 'check', 'audit'].includes(opts.cmd)) throw new Error(`Unknown command: ${opts.cmd}\n\n${USAGE}`)

  const entries = await loadServers(opts.config, opts.only)
  const snaps = await snapshotAll(entries)
  const threshold = SEVERITY_RANK[opts.failOn] ?? Infinity
  let failed = false
  const report = {}

  for (const [name, snap] of Object.entries(snaps)) {
    if (snap.error) {
      report[name] = { error: snap.error }
      failed = true
      if (!opts.json) console.log(`\n${name}: could not connect (${snap.error})`)
      continue
    }
    const findings = lintSnapshot(snap)
    report[name] = { findings }
    if (findings.some((f) => SEVERITY_RANK[f.severity] >= threshold)) failed = true
    if (!opts.json) {
      console.log(`\n${name} (${snap.server.name ?? '?'} ${snap.server.version ?? ''})`)
      if (findings.length) printFindings(name, findings)
      else console.log('  no risky instructions found')
    }
  }

  if (opts.cmd === 'lock') {
    const lock = { lockfileVersion: 1, generatedAt: new Date().toISOString(), servers: {} }
    for (const [name, snap] of Object.entries(snaps)) if (!snap.error) lock.servers[name] = snap
    await writeFile(opts.lockfile, JSON.stringify(lock, null, 2) + '\n')
    if (!opts.json) console.log(`\nWrote ${opts.lockfile} (${Object.keys(lock.servers).length} servers). Commit it, then run "mcp-lock check" in CI.`)
    else console.log(JSON.stringify(report, null, 2))
    return process.exit(Object.values(snaps).some((s) => s.error) ? 1 : 0)
  }

  if (opts.cmd === 'check') {
    if (!existsSync(opts.lockfile)) throw new Error(`Lockfile not found: ${opts.lockfile}. Run "mcp-lock lock" first.`)
    const lock = JSON.parse(await readFile(opts.lockfile, 'utf8'))
    for (const [name, snap] of Object.entries(snaps)) {
      if (snap.error) continue
      const locked = lock.servers?.[name]
      const changes = locked ? diffServer(locked, snap) : [{ kind: 'server', key: name, change: 'added' }]
      report[name].changes = changes
      if (changes.length) failed = true
      if (!opts.json) {
        if (!changes.length) console.log(`  ✓ ${name}: matches the lockfile`)
        for (const c of changes) {
          const fields = c.fields?.length ? ` (${c.fields.join(', ')})` : ''
          console.log(`  ${ICON[c.change]} ${name}: ${c.kind}/${c.key} ${c.change}${fields}`)
        }
      }
    }
    for (const name of Object.keys(lock.servers ?? {})) {
      if (!(name in snaps)) {
        report[name] = { changes: [{ kind: 'server', key: name, change: 'removed' }] }
        failed = true
        if (!opts.json) console.log(`  - ${name}: in the lockfile but not in ${opts.config}`)
      }
    }
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2))
  else console.log(failed ? '\nmcp-lock: review the changes above. If they are expected, run "mcp-lock lock".' : '\nmcp-lock: all good.')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(`mcp-lock: ${err.message}`)
  process.exit(2)
})
