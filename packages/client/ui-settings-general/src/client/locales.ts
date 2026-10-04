/**
 * Shell chrome and General-nav dictionaries. Feature rows own their copy; the
 * bind-address row is the exception — its own row ships with this package, so
 * its dictionary does too, in a namespace of its own.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'shortcut.open': '打开设置',
  'desktop.update.available': '新版本',
  'desktop.update.checking': '正在检查更新…',
  'desktop.update.progress': '{percent}%',
  'desktop.update.verifying': '正在校验更新文件…',
  'desktop.update.installing': '正在准备重启…',
  'desktop.update.ready': '安装并重启',
  'desktop.update.retry': '重试更新',
  'desktop.update.versionDetail': '{label}：{version}',
  'desktop.update.downloadDetail': '正在下载更新：{percent}%\n目标版本：{version}',
  'desktop.update.checkFailed': '检查更新失败，请稍后重试。',
  'desktop.update.downloadFailed': '下载更新失败，请重试。',
  'desktop.update.installFailed': '安装更新失败，请稍后重试。',
  'desktop.update.checkNetworkFailed': '检查更新失败，请检查网络连接后重试。',
  'desktop.update.downloadNetworkFailed': '下载更新失败，请检查网络连接后重试。',
  'desktop.update.installNetworkFailed': '安装更新失败，请检查网络连接后重试。',
  'desktop.update.stopFailed': '未能安全停止任务，更新尚未安装，请稍后重试。',
  'desktop.update.tasksChanged': '有新任务开始运行，请重新确认是否停止任务并更新。',
  'desktop.update.tasksUnavailable': '无法确认任务状态，请在工作区就绪后重试更新。',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'general.currentVersion': '当前版本：{version}',
  'developerTools.title': '显示代码工作视图',
  'developerTools.error': '保存失败，请重试',
  'developerTools.description': '开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换',
  'connection.error': '连接异常，刷新重试',
  'connection.connecting': '重新连接中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中断，正在重试，点击立即重连',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'shortcut.open': 'Open settings',
  'desktop.update.available': 'Update',
  'desktop.update.checking': 'Checking for updates…',
  'desktop.update.progress': '{percent}%',
  'desktop.update.verifying': 'Verifying update files…',
  'desktop.update.installing': 'Preparing to restart…',
  'desktop.update.ready': 'Install and Restart',
  'desktop.update.retry': 'Retry update',
  'desktop.update.versionDetail': '{label}: {version}',
  'desktop.update.downloadDetail': 'Downloading update: {percent}%\nTarget version: {version}',
  'desktop.update.checkFailed': 'Could not check for updates. Please try again later.',
  'desktop.update.downloadFailed': 'Could not download the update. Please try again.',
  'desktop.update.installFailed': 'Could not install the update. Please try again later.',
  'desktop.update.checkNetworkFailed': 'Could not check for updates. Check your connection and try again.',
  'desktop.update.downloadNetworkFailed': 'Could not download the update. Check your connection and try again.',
  'desktop.update.installNetworkFailed': 'Could not install the update. Check your connection and try again.',
  'desktop.update.stopFailed': 'Could not safely stop the tasks. The update has not been installed. Please try again later.',
  'desktop.update.tasksChanged': 'New tasks have started. Confirm again to stop the tasks and update.',
  'desktop.update.tasksUnavailable': 'Task status is unavailable. Try updating again when the workspace is ready.',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'general.currentVersion': 'Current version: {version}',
  'developerTools.title': 'Show coding view',
  'developerTools.error': 'Could not save. Please try again.',
  'developerTools.description': 'Shows trajectory, code diffs, and all Agent presets',
  'connection.error': 'Disconnected',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Reconnecting, reconnect now',
} satisfies Record<SettingsKey, string>

/**
 * Bind-address row dictionary (the `settings.network` namespace). The row owns
 * a namespace of its own rather than the shell's: the words are the row's,
 * and the shell's dictionary stays the chrome/section vocabulary. Simplified
 * Chinese (the key-set source of truth).
 */
export const zhNetwork = {
  'network.title': '监听地址',
  'network.description': '修改后写入配置文件，在下次启动 harness 时生效。',
  'network.active': '已生效',
  'network.restart': '重启后生效',
  'network.bound': '当前生效',
  'network.persisted': '已保存',
  'network.notSet': '未指定',
  'network.loading': '正在读取监听地址…',
  'network.loadFailed': '无法读取监听地址，请重试。',
  'network.custom': '自定义监听地址',
  'network.customPlaceholder': 'IPv4 地址或 localhost',
  'network.save': '保存',
  'network.saved': '监听地址已保存，重启后生效。',
  'network.saveFailed': '保存监听地址失败，请重试。',
  'network.pinned': '本次启动由 --host 指定为 {host}：保存已写入，去掉该参数后才会生效。',
  'network.wildcardWarning': '0.0.0.0 会监听所有 IPv4 接口（含容器网桥），且不包含 IPv6。',
  'network.nonLoopbackWarning': '非回环地址会对局域网开放，下次启动需要持久访问令牌。',
  'network.readOnly.remoteHost': '此页面运行在远端 harness 上，监听地址只能在运行 harness 的机器上修改。',
  'network.readOnly.noProfile': '此部署没有可写入的配置文件，监听地址只能在运行 harness 的机器上修改。',
  'network.readOnly.noRow': '当前组合没有 lan-access 配置行，无法在这里修改监听地址。',
} satisfies Record<string, string>

/** The `settings.network` key union. */
export type NetworkKey = keyof typeof zhNetwork

/** English bind-address dictionary, checked complete against the zh key set. */
export const enNetwork = {
  'network.title': 'Listen address',
  'network.description': 'Writes to the configuration file and takes effect when the harness next starts.',
  'network.active': 'In effect',
  'network.restart': 'After restart',
  'network.bound': 'In effect now',
  'network.persisted': 'Saved',
  'network.notSet': 'Not set',
  'network.loading': 'Reading the listen address…',
  'network.loadFailed': 'Could not read the listen address. Please try again.',
  'network.custom': 'Custom listen address',
  'network.customPlaceholder': 'IPv4 address or localhost',
  'network.save': 'Save',
  'network.saved': 'Listen address saved. It takes effect after a restart.',
  'network.saveFailed': 'Could not save the listen address. Please try again.',
  'network.pinned': 'This start was pinned to {host} by --host: the save is stored, and takes effect once that flag is removed.',
  'network.wildcardWarning': '0.0.0.0 listens on every IPv4 interface (container bridges included), and publishes no IPv6.',
  'network.nonLoopbackWarning': 'A non-loopback address is reachable from the local network, and the next start requires a persistent access token.',
  'network.readOnly.remoteHost': 'This page runs on a remote harness; the listen address can only be changed on the machine running the harness.',
  'network.readOnly.noProfile': 'This deployment has no writable configuration file; the listen address can only be changed on the machine running the harness.',
  'network.readOnly.noRow': 'This composition has no lan-access row, so the listen address cannot be changed here.',
} satisfies Record<NetworkKey, string>
