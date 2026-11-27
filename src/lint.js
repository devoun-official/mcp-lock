// Heuristic checks for instructions hidden in MCP tool, prompt and resource descriptions.
// These are signals for a human to review, not proof of an attack: each finding says which
// rule fired and quotes the text that triggered it.

const RULES = [
  {
    id: 'override-instructions',
    severity: 'high',
    test: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|system|other)\b[^.]{0,20}\b(instruction|prompt|rule|message)s?\b/i,
    why: 'Tries to override the agent or system instructions.',
  },
  {
    id: 'hide-from-user',
    severity: 'high',
    test: /\b(do not|don't|never)\b[^.]{0,30}\b(tell|inform|show|mention|reveal|notify)\b[^.]{0,20}\b(the )?user\b/i,
    why: 'Asks the agent to keep something from the user.',
  },
  {
    id: 'exfiltration',
    severity: 'high',
    test: /\b(send|forward|upload|post|copy|exfiltrate|transmit)\b[^.]{0,60}\b(to|at)\b[^.]{0,40}(https?:\/\/|\b[\w.-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{7,})/i,
    why: 'Asks the agent to send data to an external address, number or URL.',
  },
  {
    id: 'credential-files',
    severity: 'high',
    test: /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.git-credentials|\bwallet\.dat\b|(^|[\s'"`(\/])\.env(\.[\w-]+)?\b)/i,
    why: 'Points at credential files (SSH keys, cloud credentials, .env); check why a tool needs them.',
  },
  {
    id: 'secret-words',
    severity: 'low',
    test: /\b(api[_ -]?keys?|secret[_ -]?keys?|access[_ -]?tokens?|private[_ -]?keys?|passwords?)\b/i,
    why: 'Mentions secrets; usually fine, but confirm the tool should handle them.',
  },
  {
    id: 'other-tools',
    severity: 'medium',
    test: /\b(before|after|instead of|whenever)\b[^.]{0,40}\b(call|use|invoke|run)(ing)?\b[^.]{0,30}\b(any|other|another|the \w+) (tool|server)s?\b/i,
    why: 'Tries to change how the agent uses other tools or servers (tool shadowing).',
  },
  {
    id: 'hidden-characters',
    severity: 'high',
    test: /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u,
    why: 'Contains invisible Unicode characters that can hide instructions.',
  },
  {
    id: 'hidden-markup',
    severity: 'medium',
    test: /<\s*(important|system|instructions?|secret|hidden)\b[^>]*>|<!--[\s\S]*?-->/i,
    why: 'Contains tags or comments that are often used to hide instructions from people.',
  },
  {
    id: 'external-url',
    severity: 'low',
    test: /https?:\/\/[^\s)"'<>]+/i,
    why: 'Links to an external URL; confirm it is expected.',
  },
]

/** Extract the human/model-readable text of one item (tool, prompt or resource). */
export function textOf(item) {
  const parts = [item.title, item.description]
  if (item.inputSchema) collectSchemaText(item.inputSchema, parts)
  if (Array.isArray(item.arguments)) for (const a of item.arguments) parts.push(a.name, a.description)
  return parts.filter((p) => typeof p === 'string' && p.length > 0).join('\n')
}

function collectSchemaText(schema, out) {
  if (!schema || typeof schema !== 'object') return
  if (typeof schema.description === 'string') out.push(schema.description)
  if (typeof schema.title === 'string') out.push(schema.title)
  for (const value of Object.values(schema)) {
    if (value && typeof value === 'object') collectSchemaText(value, out)
  }
}

/** Run every rule over one item. Returns [{ rule, severity, why, excerpt }]. */
export function lintItem(item) {
  const text = textOf(item)
  const findings = []
  for (const rule of RULES) {
    const m = text.match(rule.test)
    if (!m) continue
    const start = Math.max(0, m.index - 30)
    const excerpt = text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim()
    findings.push({ rule: rule.id, severity: rule.severity, why: rule.why, excerpt: visible(excerpt) })
  }
  return findings
}

/** Make invisible characters visible in output, e.g. "​" -> "<U+200B>". */
function visible(s) {
  return s.replace(/[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/gu, (c) =>
    `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`,
  )
}

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3 }
