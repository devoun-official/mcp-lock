// Connect to one MCP server and capture everything it exposes to the model:
// tools, prompts and resources (which is also how servers deliver skills), with a
// stable hash per item so any change shows up as a diff.
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** JSON with sorted keys, so the same content always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// Only fields that change what the model sees or can do are pinned. Volatile fields
// (e.g. _meta timestamps) are left out so a lockfile does not churn for no reason.
const PICK = {
  tools: (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations }),
  prompts: (p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments }),
  resources: (r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType }),
}

async function listAll(fn) {
  const items = []
  let cursor
  do {
    const page = await fn(cursor ? { cursor } : {})
    items.push(...(page.tools ?? page.prompts ?? page.resources ?? []))
    cursor = page.nextCursor
  } while (cursor)
  return items
}

/** Key items by name (or uri), adding #2, #3 for duplicates so none silently overwrite another. */
function keyed(kind, raw) {
  const out = {}
  for (const item of raw) {
    const base = kind === 'resources' ? item.uri : item.name
    let key = base
    for (let n = 2; key in out; n++) key = `${base}#${n}`
    const pinned = PICK[kind](item)
    out[key] = { hash: sha256(canonical(pinned)), item: pinned }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

function transportFor(server) {
  if (server.url) return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {} } })
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...(server.env ?? {}) },
    stderr: 'ignore',
  })
}

/**
 * Snapshot one server. `server` is an .mcp.json entry:
 * { command, args, env } for stdio, or { url, headers } for streamable HTTP.
 */
export async function snapshotServer(server, { timeoutMs = 30000 } = {}) {
  const client = new Client({ name: 'mcp-lock', version: '0.1.0' })
  const transport = transportFor(server)
  const timer = setTimeout(() => transport.close?.(), timeoutMs)
  try {
    await client.connect(transport)
    const caps = client.getServerCapabilities() ?? {}
    const info = client.getServerVersion() ?? {}
    const tools = caps.tools ? await listAll((p) => client.listTools(p)) : []
    const prompts = caps.prompts ? await listAll((p) => client.listPrompts(p)) : []
    const resources = caps.resources ? await listAll((p) => client.listResources(p)) : []
    return {
      server: { name: info.name, version: info.version },
      instructions: client.getInstructions?.() ?? undefined,
      tools: keyed('tools', tools),
      prompts: keyed('prompts', prompts),
      resources: keyed('resources', resources),
    }
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}
