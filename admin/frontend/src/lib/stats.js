import { cleanLogMessage } from './logs.js'

function statsLocalDay(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function statsShiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00`)
  date.setDate(date.getDate() + offset)
  return statsLocalDay(date)
}

function classifyStatsLog(message) {
  return {
    group: /(群聊|群组|message\.group)/i.test(message),
    private: /(私聊|好友|message\.private)/i.test(message),
    media: /(图片|视频|文件|表情|\[image:|\[video:|\[file:)/i.test(message),
  }
}

export function deriveStatsFromLogs(logs, bots) {
  const botMap = new Map((Array.isArray(bots) ? bots : []).map((bot) => [String(bot.name), bot]))
  const rows = new Map()
  const intradayRows = new Map()
  const today = statsLocalDay(new Date())
  for (const log of Array.isArray(logs) ? logs : []) {
    const message = cleanLogMessage(log?.message || '')
    const direction = /接收\s*<-/.test(message) ? 'received' : /发送\s*->/.test(message) ? 'sent' : null
    if (!direction) continue
    const bot = botMap.get(String(log?.source || ''))
    if (!bot) continue
    const day = statsLocalDay(log?.timestamp || Date.now())
    const key = `${bot.id}|${day}`
    const row = rows.get(key) || { bot_id: bot.id, day, received: 0, sent: 0, groups: 0, private: 0, media: 0, commands: 0 }
    row[direction] += 1
    const type = classifyStatsLog(message)
    if (type.group) row.groups += 1
    if (type.private) row.private += 1
    if (type.media) row.media += 1
    if (/接收\s*<-\s*[^|]*\|\s*(?:[!/]|命令)/i.test(message)) row.commands += 1
    rows.set(key, row)
    const occurred = new Date(log?.timestamp || Date.now())
    if (!Number.isNaN(occurred.getTime())) {
      const time = `${String(occurred.getHours()).padStart(2, '0')}:00`
      const exactTime = `${String(occurred.getHours()).padStart(2, '0')}:${String(occurred.getMinutes()).padStart(2, '0')}`
      const intradayKey = `${bot.id}|${day}|${time}`
      const intradayRow = intradayRows.get(intradayKey) || { day, time, last_at: null, received: 0, sent: 0, groups: 0, private: 0, media: 0, commands: 0 }
      intradayRow.last_at = !intradayRow.last_at || exactTime > intradayRow.last_at ? exactTime : intradayRow.last_at
      intradayRow[direction] += 1
      if (type.group) intradayRow.groups += 1
      if (type.private) intradayRow.private += 1
      if (type.media) intradayRow.media += 1
      if (/接收\s*<-\s*[^|]*\|\s*(?:[!/]|命令)/i.test(message)) intradayRow.commands += 1
      intradayRows.set(intradayKey, intradayRow)
    }
  }

  const rowList = [...rows.values()]
  const sumRows = (items) => items.reduce((total, row) => ({
    received: total.received + row.received,
    sent: total.sent + row.sent,
    total: total.received + row.received + total.sent + row.sent,
    groups: total.groups + row.groups,
    private: total.private + row.private,
    media: total.media + row.media,
    commands: total.commands + row.commands,
  }), { received: 0, sent: 0, total: 0, groups: 0, private: 0, media: 0, commands: 0 })
  const period = (start) => {
    const items = rowList.filter((row) => row.day >= start && row.day <= today)
    const summary = sumRows(items)
    return { ...summary, active_days: new Set(items.map((row) => row.day)).size }
  }
  const todayDate = new Date(`${today}T00:00:00`)
  const weekStart = statsLocalDay(new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate() - todayDate.getDay() + (todayDate.getDay() === 0 ? -6 : 1)))
  const monthStart = `${today.slice(0, 8)}01`
  const periods = { day: period(today), week: period(weekStart), month: period(monthStart) }
  const botPeriods = Object.fromEntries(Object.entries({
    day: today,
    week: weekStart,
    month: monthStart,
  }).map(([name, start]) => [name, (Array.isArray(bots) ? bots : []).map((bot) => {
    const summary = sumRows(rowList.filter((row) => row.bot_id === bot.id && row.day >= start && row.day <= today))
    return { id: bot.id, name: bot.name, qq: bot.qq, ...summary }
  }).sort((a, b) => b.total - a.total)]))
  const series = Array.from({ length: 14 }, (_, index) => {
    const day = statsShiftDay(today, index - 13)
    return { day, ...sumRows(rowList.filter((row) => row.day === day)) }
  })
  const buildIntraday = (day) => Array.from({ length: 24 }, (_, hour) => {
    const time = `${String(hour).padStart(2, '0')}:00`
    const values = [...intradayRows.values()]
      .filter((row) => row.day === day && row.time === time)
      .reduce((total, row) => ({
        last_at: !total.last_at || (row.last_at && row.last_at > total.last_at) ? row.last_at : total.last_at,
        received: total.received + row.received,
        sent: total.sent + row.sent,
        groups: total.groups + row.groups,
        private: total.private + row.private,
        media: total.media + row.media,
        commands: total.commands + row.commands,
      }), { last_at: null, received: 0, sent: 0, groups: 0, private: 0, media: 0, commands: 0 })
    return { time, ...values, total: values.received + values.sent }
  })
  const intradayByDay = Object.fromEntries(series.map((item) => [item.day, buildIntraday(item.day)]))
  return { periods, bots: botPeriods, series, intraday: intradayByDay[today] || buildIntraday(today), intraday_by_day: intradayByDay, updated_at: new Date().toISOString() }
}
