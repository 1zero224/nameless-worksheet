import { describe, expect, it } from 'vitest';
import {
  createUploadSessionBodySchema,
  detectPreviewKind,
  formatFileSize,
  getSafePreviewContentType,
  normalizeMimeType,
  sanitizeFilename,
} from './upload.js';

describe('sanitizeFilename', () => {
  it('保留中文、日文、韩文、空格与常见符号', () => {
    expect(sanitizeFilename('  【无名字幕组】第01话 [JP_CN] テスト 한국어 (v2).ass  ')).toBe(
      '【无名字幕组】第01话 [JP_CN] テスト 한국어 (v2).ass',
    );
  });

  it('去除路径分隔符、控制字符与路径穿越序列', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\test\\字幕\\ep01.srt')).toBe('ep01.srt');
    expect(sanitizeFilename('foo\u0000\u001fbar\u007f.txt')).toBe('foobar.txt');
    expect(sanitizeFilename('a..b...ass')).toBe('a.b.ass');
  });

  it('空文件名、纯点或纯控制字符兜底 untitled', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('   ')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
    expect(sanitizeFilename('///\\\\')).toBe('untitled');
    expect(sanitizeFilename('\u0000\u0007')).toBe('untitled');
  });

  it('超长文件名截断至 255 字符并保留扩展名', () => {
    const longBase = '字'.repeat(300);
    const cleaned = sanitizeFilename(`${longBase}.ass`);
    expect([...cleaned].length).toBeLessThanOrEqual(255);
    expect(cleaned.endsWith('.ass')).toBe(true);
  });
});

describe('detectPreviewKind & normalizeMimeType', () => {
  it('文本扩展名识别为 text，且预览 Content-Type 不返回 text/html', () => {
    for (const ext of [
      '.ass',
      '.ssa',
      '.srt',
      '.txt',
      '.vtt',
      '.lrc',
      '.json',
      '.xml',
      '.md',
      '.log',
    ]) {
      expect(detectPreviewKind(`sample${ext}`)).toBe('text');
      expect(getSafePreviewContentType(`sample${ext}`, 'text')).toBe('application/octet-stream');
    }
  });

  it('安全栅格图片识别为 image，明确拒绝 .svg 与 HTML', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']) {
      expect(detectPreviewKind(`pic${ext}`)).toBe('image');
    }
    expect(detectPreviewKind('vector.svg', 'image/svg+xml')).toBe('unsupported');
    expect(detectPreviewKind('page.html', 'text/html')).toBe('unsupported');
    expect(detectPreviewKind('noext', 'image/svg+xml')).toBe('unsupported');
    expect(detectPreviewKind('noext', 'text/html')).toBe('unsupported');
    expect(normalizeMimeType('image/svg+xml', 'vector.svg')).toBe('application/octet-stream');
    expect(normalizeMimeType('text/html', 'index.html')).toBe('application/octet-stream');
  });

  it('音视频扩展名识别正确，容器/设计稿/压缩包/字体返回 unsupported', () => {
    expect(detectPreviewKind('clip.mp4')).toBe('video');
    expect(detectPreviewKind('clip.webm')).toBe('video');
    expect(detectPreviewKind('clip.mov')).toBe('video');
    expect(detectPreviewKind('song.mp3')).toBe('audio');
    expect(detectPreviewKind('song.flac')).toBe('audio');
    expect(detectPreviewKind('song.opus')).toBe('audio');

    for (const name of [
      'raw.mkv',
      'old.avi',
      'cover.psd',
      'font.ttf',
      'font.otf',
      'pack.zip',
      'pack.7z',
    ]) {
      expect(detectPreviewKind(name)).toBe('unsupported');
    }
  });
});

describe('formatFileSize', () => {
  it('格式化各数量级字节数', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(128.4 * 1024 * 1024)).toBe('128.4 MB');
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});

describe('createUploadSessionBodySchema', () => {
  it('校验 create_artifact 并清洗文件名', () => {
    const res = createUploadSessionBodySchema.safeParse({
      mode: 'create_artifact',
      scope: { kind: 'doc' },
      name: '字幕模板',
      filename: '../../folder/字幕 模板.ass',
      sizeBytes: 1024,
      fingerprintSha256: null,
      idempotencyKey: 'idem-key-1234567890',
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.filename).toBe('字幕 模板.ass');
      expect(res.data.skipResume).toBe(false);
    }
  });

  it('拒绝 0 字节文件与非法指纹', () => {
    const zero = createUploadSessionBodySchema.safeParse({
      mode: 'create_artifact',
      scope: { kind: 'doc' },
      name: '空文件',
      filename: 'empty.txt',
      sizeBytes: 0,
      idempotencyKey: 'idem-key-1234567890',
    });
    expect(zero.success).toBe(false);

    const badFp = createUploadSessionBodySchema.safeParse({
      mode: 'create_artifact',
      scope: { kind: 'doc' },
      name: '坏指纹',
      filename: 'a.txt',
      sizeBytes: 100,
      fingerprintSha256: 'not-a-sha256',
      idempotencyKey: 'idem-key-1234567890',
    });
    expect(badFp.success).toBe(false);
  });
});
