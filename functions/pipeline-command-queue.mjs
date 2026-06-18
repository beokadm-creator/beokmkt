export function pipelineCommandTimeMs(command = {}) {
  const value = command.created_at
  if (value instanceof Date) return value.getTime()
  if (value && typeof value.toDate === 'function') return value.toDate().getTime()
  const parsed = new Date(value ?? 0).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function commandSequence(command = {}) {
  const value = Number(command.sequence)
  return Number.isFinite(value) ? value : null
}

function commandDate(value) {
  if (value instanceof Date) return value
  if (value && typeof value.toDate === 'function') return value.toDate()
  return new Date(value ?? 0)
}

export function isRunnablePipelineCommand(command = {}, now = new Date()) {
  if (!command.active) return false
  if (command.status === 'pending') return true
  if (command.status !== 'running') return false
  return commandDate(command.lease_until) <= now
}

export function hasBlockingEarlierBatchCommand(command = {}, commands = []) {
  const batchId = typeof command.batch_id === 'string' ? command.batch_id : ''
  const sequence = commandSequence(command)
  if (!batchId || sequence === null) return false

  return commands.some((other) => {
    if (!other || other.id === command.id) return false
    if (other.batch_id !== batchId) return false
    const otherSequence = commandSequence(other)
    if (otherSequence === null || otherSequence >= sequence) return false
    return other.status !== 'succeeded'
  })
}

export function selectClaimablePipelineCommand(commands = [], now = new Date()) {
  const candidates = commands
    .filter((command) => isRunnablePipelineCommand(command, now))
    .sort((a, b) => pipelineCommandTimeMs(a) - pipelineCommandTimeMs(b))

  return candidates.find((command) => !hasBlockingEarlierBatchCommand(command, commands)) ?? null
}
