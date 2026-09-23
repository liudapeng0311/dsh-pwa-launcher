/**
 * 会话头部的 launcher 控件。
 *
 * 一个 28px 的胶囊，里面两个按钮：`⟳ 重启` 和版本按钮（有新版时点它就是升级）。
 *
 * 外观（高度、圆角、边框、hover、分段线）逐项对齐同一个 utilities 容器里
 * open-in-app 那个分裂按钮，这样两者并排时是同一视觉重量。
 *
 * 只依赖 React —— 平台的 UI 原语（Tooltip / Menu / 图标）虽然也能 require，
 * 但那些名字不在本包能核对的契约里，用它们等于把「按钮能不能画出来」赌在另一个
 * 包的内部导出上。提示用 title，进度用自己画的卡片，零耦合。
 */

/** 重启按钮的文案键（按阶段）。 */
const RESTART_LABEL = {
  idle: 'restart.label',
  calling: 'restart.calling',
  waiting: 'restart.waiting',
  reconnecting: 'restart.waiting',
  timeout: 'action.failed',
  error: 'action.failed'
}

/**
 * 把控制器接进 React。
 *
 * 控制器一页一份，所以用「订阅 + 取快照」。手写一份等价实现，
 * 省掉 require('react') 之外的任何东西。
 */
function useLauncher(controller) {
  const [snapshot, setSnapshot] = React.useState(() => ({
    update: controller.update,
    action: controller.actionSnapshot()
  }))

  React.useEffect(() => {
    setSnapshot({ update: controller.update, action: controller.actionSnapshot() })
    const offUpdate = controller.onUpdate((update) => {
      setSnapshot((previous) => ({ ...previous, update }))
    })
    const offAction = controller.onAction((action) => {
      setSnapshot((previous) => ({ ...previous, action }))
    })
    return () => {
      offUpdate()
      offAction()
    }
  }, [controller])

  return snapshot
}

/** update.newer 里每一项的通道 → 文案键。 */
const CHANNEL_LABEL = {
  latest: 'channel.latest',
  next: 'channel.next',
  alpha: 'channel.alpha'
}

/**
 * 选版卡：候选不止一个时，让用户自己挑升到哪个。
 *
 * 为什么必须给这个入口：宿主只推荐一个版本（最保守通道里最新的那个），
 * 但 newer 里可能同时有 rc 和 alpha。服务端的白名单校验认的是整个 newer 列表，
 * 所以「升 rc 而不是 alpha」本来是合法的，只是原来界面没给路。
 *
 * 用全屏卡而不是从胶囊弹出的浮层：胶囊带着 overflow:hidden，浮层会被裁掉，
 * 而且它贴在一个 28px 的行内控件旁边，定位很容易出洋相。
 *
 * @param props.versions - update.newer（按保守 → 激进排好）。
 * @param props.selected - 当前选中的版本号。
 * @param props.current - 当前安装的版本号。
 * @param props.onPick - 切换选中项。
 * @param props.onConfirm - 确认升级。
 * @param props.onCancel - 关掉卡片。
 * @param props.t - 翻译函数。
 * @returns 选版卡元素。
 */
function VersionPickerCard({ versions, selected, current, onPick, onConfirm, onCancel, t }) {
  return React.createElement(
    'div',
    { className: 'dsh-launcher-card', role: 'dialog', 'aria-label': t('pick.title') },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cardbox dsh-launcher-cardbox-wide' },
      React.createElement(
        'div',
        { className: 'dsh-launcher-cardcol' },
        React.createElement('div', { className: 'dsh-launcher-cardtitle' }, t('pick.title')),
        React.createElement('div', { className: 'dsh-launcher-cardmsg' }, t('pick.current', { current: current ?? '?' })),
        React.createElement(
          'div',
          { className: 'dsh-launcher-picks' },
          versions.map((entry) =>
            React.createElement(
              'button',
              {
                key: entry.version,
                type: 'button',
                className: 'dsh-launcher-pick',
                'data-selected': entry.version === selected ? 'true' : undefined,
                'aria-pressed': entry.version === selected ? 'true' : 'false',
                onClick: () => onPick(entry.version)
              },
              React.createElement('span', { className: 'dsh-launcher-pickradio', 'aria-hidden': true }),
              React.createElement('span', { className: 'dsh-launcher-pickversion' }, entry.version),
              React.createElement(
                'span',
                { className: 'dsh-launcher-pickmeta' },
                t(CHANNEL_LABEL[entry.channel] ?? 'channel.other'),
                entry.ignored ? ` · ${t('pick.ignored')}` : '',
                entry.version === selected ? ` · ${t('pick.chosen')}` : ''
              )
            )
          )
        ),
        versions.some((entry) => entry.ignored)
          ? React.createElement('div', { className: 'dsh-launcher-cardnote' }, t('pick.ignoredNote'))
          : null,
        React.createElement(
          'div',
          { className: 'dsh-launcher-cardrow' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-launcher-cardbtn dsh-launcher-cardbtn-primary',
              onClick: onConfirm
            },
            t('pick.confirm', { version: selected ?? '?' })
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-launcher-cardbtn', onClick: onCancel },
            t('pick.cancel')
          )
        ),
        React.createElement('div', { className: 'dsh-launcher-cardnote' }, t('pick.caveat'))
      )
    )
  )
}

/**
 * 全屏进度卡：确认之后的等待、失败时的说明。
 *
 * 为什么需要它：重启/升级会杀掉当前进程，页面在这段时间里做不了任何事。
 * 光把状态写在 8 个字宽的按钮上说不清楚，用户会以为界面卡死了。
 *
 * @param props.action - 动作快照（action / phase / failure / detail / selected）。
 * @param props.onDismiss - 失败或超时后收起卡片。
 * @param props.t - 翻译函数。
 * @returns 卡片元素，或 null（没有动作时完全不渲染）。
 */
function ActionCard({ action, onDismiss, t }) {
  const kind = action?.action ?? null
  const phase = action?.phase ?? 'idle'
  if (kind === null) return null

  const spinning = phase === 'calling' || phase === 'waiting' || phase === 'reconnecting'
  const isUpgrade = kind === 'upgrade'

  let title
  let message
  if (spinning) {
    title = isUpgrade ? t('action.upgrade.title', { version: action.detail ?? '?' }) : t('action.restart.title')
    if (phase === 'calling') message = t('action.calling')
    else if (phase === 'reconnecting') message = t('action.reconnecting')
    else message = t('action.waiting')
  } else {
    title = t('action.failed.title')
    if (action.failure === 'timeout') message = t('action.timeout')
    else if (action.failure === 'unauthorized') message = t('action.unauthorized')
    else if (action.failure === 'server') message = t('action.server', { reason: action.detail ?? '?' })
    else message = t('action.offline')
  }

  return React.createElement(
    'div',
    { className: 'dsh-launcher-card', role: 'alert' },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cardbox' },
      spinning ? React.createElement('span', { className: 'dsh-launcher-spin', 'aria-hidden': true }) : null,
      React.createElement(
        'div',
        { className: 'dsh-launcher-cardcol' },
        React.createElement('div', { className: 'dsh-launcher-cardtitle' }, title),
        React.createElement('div', { className: 'dsh-launcher-cardmsg' }, message),
        spinning
          ? null
          : React.createElement(
              'button',
              { type: 'button', className: 'dsh-launcher-cardbtn', onClick: onDismiss },
              t('action.dismiss')
            )
      )
    )
  )
}

/**
 * 「重启 | 版本」胶囊 + 进度卡。
 *
 * @param props.controller - 一页一份的 LauncherController。
 * @param props.t - conversation 命名空间的翻译函数（slot 注入的）。
 * @returns 胶囊与卡片。
 */
export function LauncherControls({ controller, t }) {
  const { update, action } = useLauncher(controller)
  const busy = action.phase === 'calling' || action.phase === 'waiting' || action.phase === 'reconnecting'
  const restarting = busy && action.action === 'restart'

  React.useEffect(() => {
    // 标签页被冻结过之后（后台标签、系统休眠），轮询可能停在中间态。
    // 回到前台时踢一脚，让它继续收敛。
    const onVisible = () => {
      if (document.visibilityState === 'visible') controller.resume()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [controller])

  const onRestartClick = () => {
    if (busy) return
    if (!window.confirm(t('restart.confirm'))) return
    controller.restart()
  }

  // —— 版本按钮的文案 / 提示 / 强调态 ——
  const current = update.current ?? '?'
  const checking = update.status === 'idle' || update.status === 'checking'
  const available = Boolean(update.available) && typeof update.target === 'string' && update.target.length > 0
  const canApply = update.canApply !== false
  const newer = Array.isArray(update.newer) ? update.newer : []

  let updateLabel
  let updateTitle
  let accent = false
  if (checking) {
    updateLabel = t('update.checking')
    updateTitle = t('update.checking.title')
  } else if (available) {
    // 只提醒模式（allowSelfUpdate=false）下点它不会装，所以文案也不能说会装。
    updateLabel = t('update.available', { version: update.target, current })
    updateTitle = canApply
      ? t('update.available.apply', { version: update.target, current })
      : t('update.available.manual', { version: update.target, current })
    accent = true
  } else if (update.status === 'error') {
    updateLabel = t('update.error')
    updateTitle = t('update.error.title', { reason: update.error ?? '?' })
  } else if (newer.length > 0) {
    updateLabel = t('update.ignored', { count: newer.length })
    updateTitle = t('update.ignored.title', { count: newer.length })
  } else {
    updateLabel = t('update.latest')
    updateTitle = t('update.latest.title', { current })
  }

  // 候选多于一个时，点版本按钮先摆出选版卡 —— 只升「推荐的那个」会把
  // 「其实也能升 rc」这件事藏起来，而服务端白名单本来就允许升 newer 里的任意一个。
  const choosing = action.phase === 'select'
  const onUpdateClick = () => {
    if (busy || checking) return
    if (choosing) {
      controller.cancelSelection()
      return
    }
    if (available && canApply) {
      if (newer.length > 1) {
        controller.openPicker(update.target)
        return
      }
      if (!window.confirm(t('update.confirm', { version: update.target, current }))) return
      controller.upgrade(update.target)
      return
    }
    controller.recheck()
  }

  return React.createElement(
    'div',
    { className: 'dsh-launcher-root' },
    React.createElement(
      'div',
      { className: 'dsh-launcher-cluster' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-launcher-btn',
          disabled: busy,
          'aria-label': `${t('restart.label')}：${t('restart.title')}`,
          title: t('restart.title'),
          onClick: onRestartClick
        },
        React.createElement('span', { className: 'dsh-launcher-glyph', 'aria-hidden': true }, '\u21bb'),
        React.createElement('span', null, restarting ? t('restart.calling') : t('restart.label'))
      ),
      React.createElement('span', { className: 'dsh-launcher-sep', 'aria-hidden': true }),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-launcher-btn',
          'data-accent': accent ? 'true' : undefined,
          disabled: busy,
          'aria-label': `${updateLabel}：${updateTitle}`,
          title: updateTitle,
          onClick: onUpdateClick
        },
        React.createElement('span', null, updateLabel)
      )
    ),
    choosing
      ? React.createElement(VersionPickerCard, {
          versions: newer,
          selected: action.selected,
          current: update.current,
          onPick: (version) => controller.selectVersion(version),
          onConfirm: () => {
            const chosen = action.selected
            if (!window.confirm(t('update.confirm', { version: chosen ?? '?', current }))) return
            controller.confirmSelection()
          },
          onCancel: () => controller.cancelSelection(),
          t
        })
      : React.createElement(ActionCard, { action, onDismiss: () => controller.dismiss(), t })
  )
}
