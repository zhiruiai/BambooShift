'use strict';
const fs = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameOrigin, trustedProductSender } = require('./security.cjs');
const limit = 2048;
const fileName = 'managed-appearance.json';
const fields = [
  'version',
  'theme',
  'accent',
  'spellCheck',
  'avatarTheme',
  'customAvatarTheme',
  'useCustomAvatarTheme',
];
const themeId = (value) =>
  typeof value === 'string' &&
  (['companions', 'pandas', 'dinosaurs', 'chicks', 'elephants'].includes(value) ||
    /^(?:open-avatar|grokbot)-[a-z0-9-]{1,80}$/.test(value));
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function validAppearance(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > limit) return false;
  try {
    const value = JSON.parse(raw);
    if (
      !record(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      value.version !== 1 ||
      !['system', 'light', 'dark'].includes(value.theme) ||
      !['bot', 'neutral'].includes(value.accent) ||
      typeof value.spellCheck !== 'boolean' ||
      (value.avatarTheme !== undefined && !themeId(value.avatarTheme)) ||
      (value.useCustomAvatarTheme !== undefined && typeof value.useCustomAvatarTheme !== 'boolean')
    )
      return false;
    if (value.customAvatarTheme !== undefined) {
      const custom = value.customAvatarTheme;
      if (
        !record(custom) ||
        Object.keys(custom).sort().join(',') !== 'backdrop,badge,colors,motif,name' ||
        typeof custom.name !== 'string' ||
        !custom.name.trim() ||
        custom.name.length > 40 ||
        !/^[\p{L}\p{N} '’·-]+$/u.test(custom.name) ||
        !themeId(custom.motif) ||
        !['none', 'star', 'flower', 'moon', 'bolt'].includes(custom.badge) ||
        !['plain', 'halo', 'solid'].includes(custom.backdrop) ||
        !Array.isArray(custom.colors) ||
        custom.colors.length !== 3 ||
        !custom.colors.every(
          (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color),
        ) ||
        new Set(custom.colors.map((color) => color.toLowerCase())).size !== 3
      )
        return false;
    } else if (value.useCustomAvatarTheme === true) return false;
    return true;
  } catch {
    return false;
  }
}
function ordinary(stat) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit))
    throw Error('Invalid preference file');
}
function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
}
function readPreference(file) {
  const entry = fs.lstatSync(file, { bigint: true });
  ordinary(entry);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    ordinary(opened);
    if (!sameFile(entry, opened)) throw Error('Preference changed');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (
      count > limit ||
      BigInt(count) !== opened.size ||
      !sameFile(opened, fs.fstatSync(fd, { bigint: true }))
    )
      throw Error('Preference changed');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
    if (!validAppearance(raw)) throw Error('Invalid appearance');
    return raw;
  } finally {
    fs.closeSync(fd);
  }
}
function checkDestination(file) {
  try {
    ordinary(fs.lstatSync(file, { bigint: true }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function createManagedAppearance(dataDir) {
  const file = join(dataDir, fileName);
  let value = null,
    available = true;
  try {
    value = readPreference(file);
  } catch (error) {
    available = error.code === 'ENOENT';
  }
  return {
    read: () => ({ value, available }),
    write(raw) {
      if (!validAppearance(raw)) return { available: false };
      value = raw;
      const temporary = join(dataDir, `.managed-appearance-${randomUUID()}.tmp`);
      let created = false;
      try {
        checkDestination(file);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        created = true;
        try {
          fs.writeFileSync(fd, raw, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        checkDestination(file);
        fs.renameSync(temporary, file);
        available = true;
      } catch {
        available = false;
      } finally {
        if (created) {
          try {
            fs.rmSync(temporary, { force: true });
          } catch {}
        }
      }
      return { available };
    },
  };
}
function readableSender(event, current, machine) {
  if (!current?.managed) return false;
  if (machine.snapshot().status === 'connected') return trustedProductSender(event, current);
  if (machine.snapshot().status !== 'connecting' || current.attached) return false;
  try {
    const contents = current.view.webContents,
      frame = event.senderFrame;
    return (
      !contents.isDestroyed() &&
      event.sender === contents &&
      frame === contents.mainFrame &&
      !frame.isDestroyed() &&
      !frame.detached &&
      frame.origin === current.origin &&
      frame.url === contents.getURL() &&
      sameOrigin(frame.url, current.origin)
    );
  } catch {
    return false;
  }
}
function installManagedAppearance({ ipcMain, getConnection, machine, dataDir }) {
  const preferences = createManagedAppearance(dataDir);
  ipcMain.on('openbot-appearance:read', (event, value) => {
    event.returnValue =
      value === undefined && readableSender(event, getConnection(), machine)
        ? preferences.read()
        : { value: null, available: false };
  });
  ipcMain.on('openbot-appearance:write', (event, value) => {
    event.returnValue = readableSender(event, getConnection(), machine)
      ? preferences.write(value)
      : { available: false };
  });
}
module.exports = { createManagedAppearance, installManagedAppearance, validAppearance, fileName };
