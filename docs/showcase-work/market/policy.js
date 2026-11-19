'use strict';
window.pickDatabase = function(local, shared) {
  // 两约束同时勾选：设备内嵌且中心协作，推荐 SQLite + PostgreSQL 分层架构
  if (local && shared) {
    return {
      tag: 'SQLite + PostgreSQL',
      title: '分层架构建议',
      reason: '终端断网独立采集用 SQLite 嵌入进程内零配置读写；总部并发汇总用 PostgreSQL 服务端处理多用户事务。两库不自动同步，需另行实现可重试同步、去重与冲突处理。边界：同步逻辑由应用层负责，此台仅给出分层方向。',
      path: ['现场终端部署 SQLite', '建立同步通道', '去重与冲突处理', '中心服务部署 PostgreSQL', '验证端到端一致性']
    };
  }
  // 两约束都不勾选：缺少关键判断依据，需人工澄清
  if (!local && !shared) {
    return {
      tag: '待补充条件',
      title: '需要补充部署条件',
      reason: '未勾选任何约束时，此台缺少判断依据。请至少勾选一项：设备内嵌表示终端独立断网采样不另起服务；中心协作表示多台终端持续并发写入同一数据库。补充后可获得明确建议。',
      path: ['补充部署条件', '选择约束', '重新评估']
    };
  }
  // 仅设备内嵌：推荐 SQLite
  if (local && !shared) {
    return {
      tag: 'SQLite',
      title: '推荐 SQLite',
      reason: 'SQLite 以零配置嵌入式引擎运行在应用进程内，无需独立数据库服务进程，适合断网采样与轻量场景。边界：同一文件同时仅支持一个写入者，大量网络并发写入时需改用客户端/服务端架构。',
      path: ['评估应用规模', '确认写入频率', '选用 SQLite', '嵌入应用进程', '验证单写者边界']
    };
  }
  // 仅中心协作：推荐 PostgreSQL
  if (!local && shared) {
    return {
      tag: 'PostgreSQL',
      title: '推荐 PostgreSQL',
      reason: 'PostgreSQL 以独立服务端运行，通过客户端连接处理多用户并发事务。MVCC 保证读写互不阻塞，适合多终端持续写入。边界：需维护独立数据库服务进程，小型嵌入式场景不建议。',
      path: ['准备服务器环境', '安装 PostgreSQL', '配置连接池', '验证并发写入', '建立备份策略']
    };
  }
};