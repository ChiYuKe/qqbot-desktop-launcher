import { normalizeLocalUrl } from './bot.js'

const LOG_SESSION_STARTED_AT = Math.floor(Date.now() / 1000) * 1000

export function orderLogs(logs) {
  return Array.isArray(logs) ? [...logs].reverse().slice(-500) : []
}

function logIdentity(log) {
  const id = String(log?.id || '').trim()
  if (id) return `id:${id}`
  return `legacy:${log?.timestamp || ''}|${log?.time || ''}|${log?.source || ''}|${log?.level || ''}|${log?.message || ''}`
}

export function isCurrentSessionLog(log) {
  const timestamp = Date.parse(String(log?.timestamp || ''))
  return Number.isFinite(timestamp) && timestamp >= LOG_SESSION_STARTED_AT
}

export function mergeCurrentSessionLogs(current, incoming) {
  const events = new Map()
  for (const log of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!isCurrentSessionLog(log)) continue
    events.set(logIdentity(log), log)
  }
  return [...events.values()].sort((left, right) => {
    const leftTime = Date.parse(String(left?.timestamp || ''))
    const rightTime = Date.parse(String(right?.timestamp || ''))
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
    return 0
  }).slice(-500)
}

export function orderCurrentSessionLogs(logs) {
  const sessionLogs = (Array.isArray(logs) ? logs : []).filter(isCurrentSessionLog)
  const unique = new Map()
  sessionLogs.forEach((log) => unique.set(logIdentity(log), log))
  return orderLogs([...unique.values()])
}

export function cleanLogMessage(message) {
  return String(message || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\[\d+(?:;\d+)*m/g, '')
}

function isQrArt(message) {
  const cleaned = cleanLogMessage(message)
  return cleaned.length >= 12 && /[█▀▄]/.test(cleaned) && cleaned.replace(/[█▀▄\s]/g, '') === ''
}

function isLogRecordHeader(message) {
  return /^\s*\[(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{4}-\d{2}-\d{2})\]/.test(message)
}

function preserveLogLineIndent(message, source) {
  const prefixRemoved = message.replace(/^\s*(?:\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\s+\[[^\]]+\]\s*/, '')
  const sourcePrefix = source ? new RegExp(`^${String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*`, 'i') : null
  return prefixRemoved.replace(sourcePrefix || /^$/, '').replace(/\s+$/, '')
}

function canAppendMultilineLine(previous, log, rawMessage, message) {
  if (!previous || previous.source !== log.source || previous.time !== log.time || !message.trim() || isLogRecordHeader(rawMessage)) return false
  return previous.kind === 'multiline' || String(previous.message || '').trimEnd().endsWith(':')
}

function compactLogMessage(message, source) {
  const prefixRemoved = message.replace(/^\s*(?:\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\s+\[[^\]]+\]\s*/, '')
  const sourcePrefix = source ? new RegExp(`^${String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|\\s*`, 'i') : null
  return prefixRemoved.replace(sourcePrefix || /^$/, '').trim()
}

function findImageTokenEnd(message, start) {
  let depth = 0
  for (let index = start; index < message.length; index += 1) {
    if (message[index] === '[') depth += 1
    if (message[index] !== ']') continue
    depth -= 1
    if (depth === 0) return index + 1
  }
  return -1
}

function parseImageToken(token) {
  const fields = {}
  const body = token.slice('[image:'.length, -1)
  const matcher = /(?:^|,)\s*([a-z_]+)=([\s\S]*?)(?=,\s*[a-z_]+=|$)/gi
  let match
  while ((match = matcher.exec(body))) fields[match[1].toLowerCase()] = match[2].trim()
  if (!/^https?:\/\//i.test(fields.url || '')) return null
  return {
    url: fields.url,
    file: fields.file || 'qq-image',
    summary: fields.summary || '图片消息',
    size: fields.file_size || '',
    truncated: /\.\.\.$/.test(fields.url),
  }
}

export function parseLogSegments(message) {
  const text = String(message || '')
  const segments = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf('[image:', cursor)
    if (start < 0) break
    const end = findImageTokenEnd(text, start)
    if (end < 0) break
    if (start > cursor) segments.push({ type: 'text', value: text.slice(cursor, start) })
    const image = parseImageToken(text.slice(start, end))
    if (image) segments.push({ type: 'image', value: image })
    else segments.push({ type: 'text', value: text.slice(start, end) })
    cursor = end
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) })
  return segments.length ? segments : [{ type: 'text', value: text }]
}

function isRedundantLog(message) {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return !normalized
    || /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[(?:trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]\s*$/i.test(normalized)
    || /二维码已保存到|二维码解码URL|如果控制台二维码无法扫码|请扫描下面的二维码/.test(normalized)
    || /^\d+\.\d+\s+\S+$/.test(normalized)
}

function isNapcatMessageLog(log) {
  const message = compactLogMessage(cleanLogMessage(log?.message), log?.source)
  return /(?:接收\s*<-|发送\s*->)\s*/.test(message)
}

export function prepareLogItems(logs) {
  const prepared = []
  const seen = new Set()
  for (let index = 0; index < logs.length; index += 1) {
    if (isNapcatMessageLog(logs[index])) continue
    const rawMessage = cleanLogMessage(logs[index].message)
    const message = compactLogMessage(rawMessage, logs[index].source)
    const multilineLine = preserveLogLineIndent(rawMessage, logs[index].source)
    const previous = prepared[prepared.length - 1]
    if (canAppendMultilineLine(previous, logs[index], rawMessage, multilineLine)) {
      previous.message = `${previous.message}\n${multilineLine}`
      previous.kind = 'multiline'
      continue
    }
    if (!isQrArt(message)) {
      if (isRedundantLog(rawMessage)) continue
      const key = `${logs[index].time}|${logs[index].source}|${rawMessage}`
      if (seen.has(key)) continue
      seen.add(key)
      const detectedLevel = rawMessage.match(/\[(trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]/i)?.[1]
      prepared.push({ ...logs[index], level: detectedLevel || logs[index].level, message })
      continue
    }

    const qrLines = [message]
    while (index + 1 < logs.length && isQrArt(logs[index + 1].message)) {
      index += 1
      qrLines.push(cleanLogMessage(logs[index].message))
    }
    prepared.push({ ...logs[index], kind: 'qr', message: qrLines.join('\n') })
  }
  return prepared
}

export function normalizeLogLevel(level, message) {
  const rawLevel = String(level || '').toLowerCase()
  const detectedLevel = String(message || '').match(/\[(trace|debug|info|notice|success|warn|warning|error|critical|fatal)\]/i)?.[1]
  const normalized = (rawLevel && rawLevel !== 'info' ? rawLevel : detectedLevel || rawLevel || 'info').toLowerCase()
  if (normalized === 'warning') return 'warn'
  if (normalized === 'critical' || normalized === 'fatal') return 'error'
  if (normalized === 'success' || normalized === 'debug' || normalized === 'warn' || normalized === 'error') return normalized
  return 'info'
}

export function findLoginVerification(logs, source) {
  const candidates = [...logs].reverse().filter((log) => !source || log.source === source)
  const challengeIndex = candidates.findIndex((log) => /proofWaterUrl|需要验证码|密码回退需要验证码|安全验证/.test(cleanLogMessage(log.message)))
  if (challengeIndex < 0) return null

  const recoveredIndex = candidates.findIndex((log) => /登录成功|登录完成|安全验证成功|二维码登录成功|登录状态.*(?:在线|成功)|账号.*(?:上线|登录成功)|(?:OneBot|NapCat).*连接成功/i.test(cleanLogMessage(log.message)))
  if (recoveredIndex >= 0 && recoveredIndex < challengeIndex) return null

  const challenge = candidates[challengeIndex]
  if (!challenge) return null
  const text = cleanLogMessage(challenge.message)
  const proofUrl = text.match(/(?:proofWaterUrl|验证[:：])\s*(https?:\/\/[^\s]+)/i)?.[1]?.replace(/[),.;]+$/, '') || ''
  const webuiLog = candidates.find((log) => /WebUI User Panel Url:\s*https?:\/\//i.test(cleanLogMessage(log.message)))
  const webuiUrl = cleanLogMessage(webuiLog?.message || '').match(/https?:\/\/[^\s]+\/webui\?token=[^\s]+/i)?.[0]?.replace(/[),.;]+$/, '') || ''
  return { proofUrl, webuiUrl: normalizeLocalUrl(webuiUrl), challengeTime: challenge.time }
}

export function resolveQuickLoginCommand(command, logs) {
  const trimmed = command.trim()
  const match = trimmed.match(/^-q\s+(\d+)$/i)
  if (!match) return trimmed
  const index = Number(match[1])
  const accounts = (Array.isArray(logs) ? logs : []).map((log) => cleanLogMessage(log.message).match(/(?:^|\s)(\d+)\.\s*(\d{5,20})\s+/)).filter(Boolean)
  const selected = accounts.find((item) => Number(item[1]) === index)
  return selected ? `-q ${selected[2]}` : trimmed
}
