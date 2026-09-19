/**
 * dsh-model-caps client.
 *
 * One settings section. It does not edit models itself; it asks the Host
 * to fill blank context windows, output caps, and thinking levels.
 * Copy lives in COPY. React is read inside functions, never at module top.
 *
 * @module dsh-model-caps/client
 */

const NS = 'dsh-model-caps'

const COPY = {
  zh: {
    section: '模型能力',
    lead: '为自定义供应商补上空白的上下文窗口、输出上限和思考等级。已经写过的值会保留，不会增删模型。',
    sync: '立即同步',
    syncing: '同步中',
    empty: '没有等待补全的自定义供应商。',
    filled: '{id}：补上了 {n} 个模型',
    unchanged: '{id}：没有新的空白字段',
    listingFailed: '{id} 的模型列表失败：{error}',
    catalogFailed: '公开目录不可用：{error}',
    unavailable: '设置服务还不可用。',
    statusFailed: '读不到同步状态。',
    syncFailed: '同步请求失败。',
  },
  en: {
    section: 'Model caps',
    lead: 'Fills blank context windows, output caps, and thinking levels on custom providers. Values you already wrote stay. Models are not added or removed.',
    sync: 'Sync now',
    syncing: 'Syncing',
    empty: 'No custom provider is waiting for caps.',
    filled: '{id}: filled {n}',
    unchanged: '{id}: nothing blank',
    listingFailed: '{id} listing failed: {error}',
    catalogFailed: 'Public catalog unavailable: {error}',
    unavailable: 'Settings are not available yet.',
    statusFailed: 'Could not read sync status.',
    syncFailed: 'Sync request failed.',
  },
}

function reactLib() {
  if (typeof React !== 'undefined') return React
  return require('react')
}

function E(type, props, ...children) {
  return reactLib().createElement(type, props, ...children)
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')
}

function panelStyle() {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '40rem',
    color: 'var(--dsw-alias-fg-base, inherit)',
    font: 'inherit',
  }
}

function buttonStyle(disabled) {
  return {
    alignSelf: 'flex-start',
    padding: '6px 12px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-base, transparent)',
    background: 'var(--dsw-alias-bg-subtle, transparent)',
    color: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
  }
}

function lineStyle() {
  return {
    margin: 0,
    color: 'var(--dsw-alias-fg-muted, inherit)',
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, COPY), `${NS}: dictionaries`)
  const t = ctx.locale.bind(NS)

  function Panel() {
    const { useEffect, useState } = reactLib()
    const [status, setStatus] = useState(null)
    const [busy, setBusy] = useState(false)
    const [fault, setFault] = useState('')

    useEffect(() => {
      let gone = false
      fetch('/api/dsh-model-caps/status')
        .then((res) => res.json())
        .then((body) => { if (!gone) setStatus(body) })
        .catch(() => { if (!gone) setFault('status') })
      return () => { gone = true }
    }, [])

    function onSync() {
      setBusy(true)
      setFault('')
      fetch('/api/dsh-model-caps/sync', { method: 'POST' })
        .then((res) => res.json())
        .then((body) => { setStatus(body); setBusy(false) })
        .catch(() => { setFault('sync'); setBusy(false) })
    }

    const providers = Array.isArray(status?.providers) ? status.providers : []
    const lines = []
    if (fault === 'status') lines.push(t('statusFailed'))
    if (fault === 'sync') lines.push(t('syncFailed'))
    if (status?.error === 'settings unavailable') lines.push(t('unavailable'))
    if (typeof status?.catalogError === 'string' && status.catalogError.length > 0) {
      lines.push(fill(t('catalogFailed'), { error: status.catalogError }))
    }
    if (status !== null && providers.length === 0 && fault === '') lines.push(t('empty'))
    for (const provider of providers) {
      if (provider.ok === false && typeof provider.error === 'string') {
        lines.push(fill(t('listingFailed'), { id: provider.id, error: provider.error }))
      }
      const n = Number(provider.filled) || 0
      lines.push(fill(n > 0 ? t('filled') : t('unchanged'), { id: provider.id, n: String(n) }))
    }

    return E('section', { style: panelStyle() },
      E('p', { style: lineStyle() }, t('lead')),
      E('button', {
        type: 'button',
        disabled: busy || status?.running === true,
        style: buttonStyle(busy || status?.running === true),
        onClick: onSync,
      }, busy || status?.running === true ? t('syncing') : t('sync')),
      ...lines.map((line, index) => E('p', { key: String(index), style: lineStyle() }, line)),
    )
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NS,
    order: 80,
    locale: NS,
    label: () => t('section'),
  }, Panel))
}
