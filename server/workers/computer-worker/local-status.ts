import { hostname, platform } from 'node:os';
import type { Page } from 'playwright-core';
import type { ComputerState } from '../../../shared/types.js';
import { capabilities, type ComputerSurface } from './protocol.js';

export function localComputerStatus(
  surface: ComputerSurface,
  desktop: ComputerState['desktop'],
  page: Page | undefined,
  takeover: boolean,
  browser?: { available: boolean; reason?: string },
): ComputerState {
  return {
    connected: true,
    name: hostname(),
    platform: platform(),
    mode: 'local',
    surface,
    desktop,
    status: takeover
      ? '正在人工接管 · Bot 电脑操作暂停'
      : surface === 'desktop'
        ? desktop?.authorized
          ? '整机桌面已启用 · 每次操作需要批准'
          : desktop?.reason || '整机桌面权限不可用'
        : browser?.available === false
          ? browser.reason || '浏览器不可用'
          : page && !page.isClosed()
            ? '浏览器已就绪'
            : '本机工作区已连接 · 浏览器尚未打开',
    capabilities:
      browser?.available === false
        ? capabilities.filter((value) => !value.startsWith('browser'))
        : capabilities,
  };
}
