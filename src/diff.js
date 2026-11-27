// Compare a fresh snapshot with the lockfile entry for the same server.

const KINDS = ['tools', 'prompts', 'resources']

/** Returns a list of changes: { kind, key, change: 'added'|'removed'|'changed', fields? } */
export function diffServer(locked, current) {
  const changes = []
  for (const kind of KINDS) {
    const before = locked?.[kind] ?? {}
    const after = current?.[kind] ?? {}
    for (const key of Object.keys(after)) {
      if (!(key in before)) changes.push({ kind, key, change: 'added' })
      else if (before[key].hash !== after[key].hash) {
        changes.push({ kind, key, change: 'changed', fields: changedFields(before[key].item, after[key].item) })
      }
    }
    for (const key of Object.keys(before)) {
      if (!(key in after)) changes.push({ kind, key, change: 'removed' })
    }
  }
  if ((locked?.instructions ?? '') !== (current?.instructions ?? '')) {
    changes.push({ kind: 'server', key: 'instructions', change: 'changed' })
  }
  return changes
}

function changedFields(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort()
}
