import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { AvatarArtwork, AvatarSourceArtwork } from '../web/src/components/AvatarArtwork';
import { AVATAR_THEMES, AVATAR_THEME_NAMES } from '../web/src/avatarThemes';
import './avatars/sync-community-packs.mjs';
import type { BotAgent } from '../shared/types';

const family: { name: string; agent: Partial<BotAgent> }[] = [
  { name: 'orb', agent: { avatar: 'orb', color: '#8b5cf6' } },
  { name: 'drop', agent: { avatar: 'drop', color: '#4088f3' } },
  { name: 'leaf', agent: { avatar: 'leaf', color: '#24b78c' } },
  { name: 'arch', agent: { avatar: 'arch', color: '#fb8742' } },
  { name: 'spark', agent: { avatar: 'spark', color: '#e9ae38' } },
  { name: 'gem', agent: { avatar: 'gem', color: '#ed7299' } },
];
const directory = resolve('web/public/avatars');
await mkdir(directory, { recursive: true });
await copyFile('shared/avatar-face-motion.json', 'mobile/assets/avatars/avatar-face-motion.json');
const rows: string[] = [];
for (const theme of AVATAR_THEMES.filter(
  (theme) => !theme.startsWith('open-avatar-') && !theme.startsWith('grokbot-'),
)) {
  const target = resolve(directory, theme);
  const mobile = resolve('mobile/assets/avatars', theme);
  await Promise.all([mkdir(target, { recursive: true }), mkdir(mobile, { recursive: true })]);
  const drawings: string[] = [];
  for (const { name, agent } of family) {
    const svg = renderToStaticMarkup(
      createElement(AvatarArtwork, { theme, shape: agent.avatar, color: agent.color, size: 512 }),
    ).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    drawings.push(svg.replace(/<svg[^>]*>/, '').replace('</svg>', ''));
    const source = renderToStaticMarkup(
      createElement(AvatarSourceArtwork, {
        theme,
        shape: agent.avatar,
        color: agent.color,
        size: 512,
      }),
    ).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    await writeFile(resolve(mobile, `${name}.svg`), source + '\n');
    for (const output of theme === 'companions' ? [target, directory] : [target]) {
      await writeFile(resolve(output, `${name}.svg`), svg + '\n');
      await sharp(Buffer.from(svg))
        .png()
        .toFile(resolve(output, `${name}.png`));
    }
  }
  const row = `<text x="32" y="35" fill="#41404b" font-family="Arial,PingFang SC,sans-serif" font-size="18">${AVATAR_THEME_NAMES[theme]}</text>
${drawings.map((drawing, index) => `<g transform="translate(${35 + index * 196} 54) scale(2)">${drawing}</g><text x="${99 + index * 196}" y="218" text-anchor="middle" fill="#72717c" font-family="Arial,sans-serif" font-size="14">${family[index].name}</text>`).join('\n')}`;
  rows.push(row);
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="250" viewBox="0 0 1200 250"><rect width="1200" height="250" rx="24" fill="#f8f8fa"/>${row}</svg>`;
  for (const output of theme === 'companions' ? [target, directory] : [target]) {
    await writeFile(resolve(output, 'family.svg'), sheet);
    await sharp(Buffer.from(sheet)).png().toFile(resolve(output, 'family.png'));
  }
}
const height = rows.length * 250;
const overview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="1200" height="${height}" rx="24" fill="#f8f8fa"/>${rows.map((row, index) => `<g transform="translate(0 ${index * 250})">${row}</g>`).join('')}</svg>`;
await writeFile(resolve(directory, 'themes.svg'), overview);
await sharp(Buffer.from(overview)).png().toFile(resolve(directory, 'themes.png'));
console.log(
  `Exported ${family.length * rows.length} original avatars and synchronized community packs for Web and Flutter`,
);
