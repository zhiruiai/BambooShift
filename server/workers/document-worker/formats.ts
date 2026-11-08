import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  type ParseInput,
  type TextAttachment,
  type ImageAttachment,
} from './contract.ts';

export async function parsePdf(input: ParseInput): Promise<TextAttachment> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const assets = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({
    data: new Uint8Array(input.bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    maxImageSize: 0,
    disableAutoFetch: true,
    cMapUrl: resolve(assets, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: resolve(assets, 'standard_fonts') + '/',
  });
  const warnings: string[] = [];
  try {
    const document = await task.promise;
    const pageCount = document.numPages;
    const count = Math.min(pageCount, ATTACHMENT_LIMITS.pdfPages);
    let text = '',
      pagesRead = 0,
      truncated = pageCount > count;
    for (
      let pageNumber = 1;
      pageNumber <= count && text.length < ATTACHMENT_LIMITS.textCharacters;
      pageNumber++
    ) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      text += `\n\n[第 ${pageNumber} 页]\n`;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!('str' in item)) continue;
            const segment = item.str + (item.hasEOL ? '\n' : ' ');
            const available = ATTACHMENT_LIMITS.textCharacters - text.length;
            text += segment.slice(0, Math.max(0, available));
            if (segment.length > available || text.length >= ATTACHMENT_LIMITS.textCharacters) {
              truncated = true;
              break;
            }
          }
          if (text.length >= ATTACHMENT_LIMITS.textCharacters) {
            await reader.cancel();
            break;
          }
        }
      } finally {
        page.cleanup();
      }
      pagesRead++;
    }
    if (pagesRead < pageCount) truncated = true;
    if (truncated) warnings.push('PDF 超过 100 页或 120,000 字符，仅返回限额内正文。');
    if (!text.replace(/\[第 \d+ 页\]/g, '').trim())
      warnings.push('没有提取到可复制文字；扫描件需要 OCR，本版本不会编造图片中的正文。');
    return {
      kind: 'text',
      name: input.name,
      mimeType: input.sourceMimeType,
      sourceMimeType: input.sourceMimeType,
      byteLength: input.bytes.length,
      text: text.trim().slice(0, ATTACHMENT_LIMITS.textCharacters),
      pageCount,
      pagesRead,
      truncated,
      warnings,
    };
  } catch (error: any) {
    if (error?.name === 'PasswordException')
      throw new Error('PDF 已加密，请先提供解除密码保护的副本。');
    throw new Error('PDF 正文解析失败，文件可能损坏或使用了不支持的结构。');
  } finally {
    await task.destroy();
  }
}

async function validateDocxZip(bytes: Buffer): Promise<void> {
  const yauzl = await import('yauzl');
  await new Promise<void>((resolveZip, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error('DOCX 压缩包结构无效。'));
          return;
        }
        let finished = false,
          count = 0,
          expanded = 0;
        const names = new Set<string>();
        const fail = (reason: string) => {
          if (finished) return;
          finished = true;
          zip.close();
          reject(new Error(reason));
        };
        zip.on('error', () => fail('DOCX 压缩包损坏或解压长度不一致。'));
        zip.on('entry', (entry: import('yauzl').Entry) => {
          count++;
          expanded += entry.uncompressedSize;
          if (
            count > ATTACHMENT_LIMITS.zipEntries ||
            expanded > ATTACHMENT_LIMITS.zipExpandedBytes ||
            entry.uncompressedSize > ATTACHMENT_LIMITS.zipEntryBytes ||
            (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)
          ) {
            fail('DOCX 解压大小、文件数量或压缩比例超过限制。');
            return;
          }
          if (
            entry.isEncrypted() ||
            ![0, 8].includes(entry.compressionMethod) ||
            entry.fileName.split(/[\\/]/).includes('..') ||
            /^(?:\/|[A-Za-z]:)/.test(entry.fileName) ||
            names.has(entry.fileName) ||
            /vbaProject\.bin$/i.test(entry.fileName)
          ) {
            fail('DOCX 包含不允许的路径、加密、宏或压缩方式。');
            return;
          }
          names.add(entry.fileName);
          if (entry.fileName.endsWith('/')) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail('DOCX 内容无法解压。');
              return;
            }
            let actual = 0,
              tail = '';
            const decoder = new TextDecoder('utf-8', { fatal: true });
            stream.on('error', () => fail('DOCX 内容损坏或解压长度超过声明。'));
            stream.on('data', (chunk: Buffer) => {
              actual += chunk.length;
              if (actual > entry.uncompressedSize || actual > ATTACHMENT_LIMITS.zipEntryBytes) {
                stream.destroy();
                fail('DOCX 解压内容超过限制。');
                return;
              }
              if (/\.(xml|rels)$/i.test(entry.fileName)) {
                let decoded: string;
                try {
                  decoded = decoder.decode(chunk, { stream: true });
                } catch {
                  stream.destroy();
                  fail('DOCX XML 必须是有效 UTF-8 文本。');
                  return;
                }
                const sample = tail + decoded;
                if (sample.includes('\0')) {
                  stream.destroy();
                  fail('DOCX XML 含有不允许的控制字符。');
                  return;
                }
                if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(sample)) {
                  stream.destroy();
                  fail('DOCX 不允许 DTD 或实体定义。');
                  return;
                }
                tail = sample.slice(-80);
              }
            });
            stream.on('end', () => {
              if (/\.(xml|rels)$/i.test(entry.fileName)) {
                try {
                  decoder.decode();
                } catch {
                  fail('DOCX XML 编码不完整。');
                  return;
                }
              }
              if (!finished) zip.readEntry();
            });
          });
        });
        zip.on('end', () => {
          if (finished) return;
          if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
            fail('文件不是有效 DOCX 文档。');
            return;
          }
          finished = true;
          zip.close();
          resolveZip();
        });
        zip.readEntry();
      },
    );
  });
}

export async function parseDocx(input: ParseInput): Promise<TextAttachment> {
  await validateDocxZip(input.bytes);
  const mammoth = await import('mammoth');
  // extractRawText uses the reader's externalFileAccess=false default and no image conversion.
  const result = await mammoth.extractRawText({ buffer: input.bytes });
  const truncated = result.value.length > ATTACHMENT_LIMITS.textCharacters;
  const warnings = result.messages.slice(0, 10).map((message) => message.message.slice(0, 500));
  if (truncated) warnings.push('DOCX 正文超过 120,000 字符，已截断。');
  if (!result.value.trim()) warnings.push('没有提取到正文；图片中的文字需要 OCR。');
  return {
    kind: 'text',
    name: input.name,
    mimeType: input.sourceMimeType,
    sourceMimeType: input.sourceMimeType,
    byteLength: input.bytes.length,
    text: result.value.slice(0, ATTACHMENT_LIMITS.textCharacters).trim(),
    truncated,
    warnings,
  };
}

export async function parseImage(input: ParseInput): Promise<ImageAttachment> {
  const { default: sharp } = await import('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
  const settings = {
    limitInputPixels: ATTACHMENT_LIMITS.imagePixels,
    failOn: 'warning' as const,
    animated: false,
  };
  const metadata = await sharp(input.bytes, settings).metadata();
  const expected =
    input.sourceMimeType === 'image/jpeg'
      ? 'jpeg'
      : input.sourceMimeType === 'image/webp'
        ? 'webp'
        : 'png';
  if (metadata.format !== expected || !metadata.width || !metadata.height)
    throw new Error('图像内容与扩展名不一致或文件损坏。');
  if (
    metadata.width > ATTACHMENT_LIMITS.imageSide ||
    metadata.height > ATTACHMENT_LIMITS.imageSide ||
    metadata.width * metadata.height > ATTACHMENT_LIMITS.imagePixels
  )
    throw new Error('图片超过 20 百万像素或单边 12,000 像素。');
  const normalize = (size: number) =>
    sharp(input.bytes, settings)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
  let image = await normalize(ATTACHMENT_LIMITS.imageOutputSide);
  if (image.data.length > ATTACHMENT_LIMITS.imageOutputBytes) image = await normalize(1280);
  if (image.data.length > ATTACHMENT_LIMITS.imageOutputBytes)
    throw new Error('图片转换后的内容超过限制。');
  const warnings: string[] = [];
  if ((metadata.pages ?? 1) > 1) warnings.push('动态图像只读取第一帧。');
  if (image.info.width !== metadata.width || image.info.height !== metadata.height)
    warnings.push('图片已按方向信息校正，并缩放到适合模型观察的尺寸。');
  return {
    kind: 'image',
    name: input.name,
    mimeType: 'image/png',
    sourceMimeType: input.sourceMimeType,
    byteLength: input.bytes.length,
    width: image.info.width,
    height: image.info.height,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    data: image.data.toString('base64'),
    truncated: false,
    warnings,
  };
}
