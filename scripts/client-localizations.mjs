import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// macOS chooses permission-prompt language using its app-language preference.
export async function writeMacLocalizations(appDirectory) {
  const descriptions = {
    en: 'Turn the audio you choose to record into text. You review the text before sending.',
    'zh-Hans': '将你主动录制的语音转成输入框中的文字，由你确认后发送。',
  };
  for (const [locale, description] of Object.entries(descriptions)) {
    const directory = join(appDirectory, 'Contents', 'Resources', `${locale}.lproj`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'InfoPlist.strings'),
      `"NSMicrophoneUsageDescription" = ${JSON.stringify(description)};\n`,
      'utf8',
    );
  }
}
