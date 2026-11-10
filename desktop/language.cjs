'use strict';
const {
  openSync,
  lstatSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  renameSync,
  rmSync,
  constants,
} = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const catalog = require('./ui/i18n.js');

function createClientLanguage(dataDir, systemLanguage = 'zh-CN') {
  const file = join(dataDir, 'client-language.json');
  let language = catalog.resolveLocale(systemLanguage);
  let persisted = true;
  try {
    const entry = lstatSync(file, { bigint: true });
    if (!entry.isFile() || entry.size > 1024n) throw new Error('Invalid language preference');
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile() || info.size > 1024n || info.dev !== entry.dev || info.ino !== entry.ino)
        throw new Error('Invalid language preference');
      const value = JSON.parse(readFileSync(fd, 'utf8'));
      if (value.version === 1 && catalog.locales.includes(value.language))
        language = value.language;
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Missing or malformed device preferences fall back to the system language. */
  }
  return {
    snapshot: () => ({ language, languagePersisted: persisted }),
    t: (key, values) => catalog.translate(language, key, values),
    message: (text) => catalog.message(language, text),
    set(value) {
      if (!catalog.locales.includes(value))
        throw new Error(catalog.translate(language, 'languageInvalid'));
      language = value;
      const temporary = join(dataDir, `.client-language-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, language }) + '\n', {
          mode: 0o600,
          flag: 'wx',
        });
        renameSync(temporary, file);
        persisted = true;
      } catch {
        persisted = false;
        try {
          rmSync(temporary);
        } catch {
          /* A rejected write must not prevent this session's choice. */
        }
      }
      return this.snapshot();
    },
  };
}
module.exports = { createClientLanguage };
