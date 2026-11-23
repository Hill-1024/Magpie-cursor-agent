export const agent = {
  id: 'cursor-bridge',
  name: 'Cursor · Magpie Bridge',
  icon: 'data:image/png;base64,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',
  bin: 'cursor',
  dir: '~/.cursor',
  config: '~/.config/magpie-cursor-bridge/connection.json',
  format: 'json',
  model: 'model',
  effort: true,
  ua: ['cursor-magpie-bridge'],
  notice:
    '打开开关即可接管 Cursor，无需重启。插件宿主会自动拉起或更新后台桥接（首次安装若弹出证书确认请选“是”）。本行只负责把 Magpie 的模型列表与主模型选择暴露给 Cursor。',
};

export function connect({ gateway, models }) {
  return {
    enabled: true,
    gateway: gateway.v1,
    key: gateway.key,
    models: Array.isArray(models)
      ? models.map(entry => ({
          id: entry.id,
          name: entry.name || entry.id,
          context: entry.context || null,
          efforts: Array.isArray(entry.efforts) ? entry.efforts : [],
        }))
      : [],
  };
}
