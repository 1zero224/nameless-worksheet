import { describe, expect, it } from 'vitest';
import {
  artifactNameSchema,
  extractCodeSchema,
  locationExpiresAtSchema,
  locationUrlSchema,
} from './artifact.js';
import { detectCloudProvider, formatShareInfo, parseShareText } from './share-parser.js';

describe('detectCloudProvider', () => {
  it('识别 8 大网盘与子域名', () => {
    expect(detectCloudProvider('https://pan.baidu.com/s/1abc')).toBe('baidu');
    expect(detectCloudProvider('https://yun.baidu.com/s/1abc')).toBe('baidu');
    expect(detectCloudProvider('https://www.alipan.com/s/xyz')).toBe('aliyun');
    expect(detectCloudProvider('https://www.aliyundrive.com/s/xyz')).toBe('aliyun');
    expect(detectCloudProvider('https://pan.quark.cn/s/987654')).toBe('quark');
    expect(detectCloudProvider('https://cloud.189.cn/t/123456')).toBe('tianyi');
    expect(detectCloudProvider('https://115.com/s/sw123')).toBe('115');
    expect(detectCloudProvider('https://115cdn.com/s/sw123')).toBe('115');
    expect(detectCloudProvider('https://anxia.com/s/sw123')).toBe('115');
    expect(detectCloudProvider('https://drive.google.com/file/d/abc/view')).toBe('gdrive');
    expect(detectCloudProvider('https://docs.google.com/spreadsheets/d/abc')).toBe('gdrive');
    expect(detectCloudProvider('https://mega.nz/file/abc#key')).toBe('mega');
    expect(detectCloudProvider('https://mega.co.nz/#!abc!key')).toBe('mega');
    expect(detectCloudProvider('https://1drv.ms/u/s!abc')).toBe('onedrive');
    expect(detectCloudProvider('https://onedrive.live.com/?id=123')).toBe('onedrive');
    expect(detectCloudProvider('https://contoso.sharepoint.com/:f:/g/abc')).toBe('onedrive');
  });

  it('未知域名或非法链接回落为 other', () => {
    expect(detectCloudProvider('https://example.com/files/raw.mkv')).toBe('other');
    expect(detectCloudProvider('http://files.subteam.org/pack.zip')).toBe('other');
    expect(detectCloudProvider('not-a-url')).toBe('other');
    expect(detectCloudProvider('javascript:alert(1)')).toBe('other');
  });
});

describe('parseShareText', () => {
  it('解析百度网盘带提取码的标准分享文案', () => {
    const raw =
      '通过网盘分享的文件：5th-BD 原片.mkv\n链接：https://pan.baidu.com/s/1abcdefg123456 \n提取码：ab12\n复制这段内容打开「百度网盘APP 即可获取」';
    const parsed = parseShareText(raw);
    expect(parsed.url).toBe('https://pan.baidu.com/s/1abcdefg123456');
    expect(parsed.provider).toBe('baidu');
    expect(parsed.extractCode).toBe('ab12');
    expect(parsed.suggestedName).toBe('5th-BD 原片.mkv');
  });

  it('解析百度网盘 URL 中携带 ?pwd= 的分享链接', () => {
    const parsed = parseShareText('链接: https://pan.baidu.com/s/1xxxx?pwd=z9k2 欢迎下载！');
    expect(parsed.url).toBe('https://pan.baidu.com/s/1xxxx?pwd=z9k2');
    expect(parsed.provider).toBe('baidu');
    expect(parsed.extractCode).toBe('z9k2');
  });

  it('解析夸克、天翼、115、阿里分享文本的不同提取码写法', () => {
    expect(
      parseShareText(
        '我用夸克网盘分享了「Live 字幕字体包」，点击链接即可保存。链接：https://pan.quark.cn/s/abc123456，提取码: qk88。',
      ),
    ).toEqual({
      url: 'https://pan.quark.cn/s/abc123456',
      provider: 'quark',
      extractCode: 'qk88',
      suggestedName: 'Live 字幕字体包',
    });

    expect(parseShareText('天翼云盘分享 https://cloud.189.cn/t/Y7v2a3 （访问码：4567）')).toEqual({
      url: 'https://cloud.189.cn/t/Y7v2a3',
      provider: 'tianyi',
      extractCode: '4567',
    });

    expect(parseShareText('115网盘资源 https://115cdn.com/s/sw999 密码：9a8b')).toEqual({
      url: 'https://115cdn.com/s/sw999',
      provider: '115',
      extractCode: '9a8b',
    });

    expect(parseShareText('https://www.alipan.com/s/mnop123456 pwd=xy99')).toEqual({
      url: 'https://www.alipan.com/s/mnop123456',
      provider: 'aliyun',
      extractCode: 'xy99',
    });
  });

  it('解析无提取码的 MEGA / Google Drive / 未知域名链接', () => {
    expect(parseShareText('https://mega.nz/file/ABCD1234#secretKey-99')).toEqual({
      url: 'https://mega.nz/file/ABCD1234#secretKey-99',
      provider: 'mega',
      extractCode: null,
    });

    expect(parseShareText('原片镜像：https://custom.mirror.org/v1/raw.mp4）')).toEqual({
      url: 'https://custom.mirror.org/v1/raw.mp4',
      provider: 'other',
      extractCode: null,
    });
  });

  it('拒绝 javascript: / data: / file: 等非法协议', () => {
    expect(parseShareText('javascript:alert(1)')).toEqual({
      url: null,
      provider: null,
      extractCode: null,
    });
    expect(parseShareText('data:text/html,<script>alert(1)</script>')).toEqual({
      url: null,
      provider: null,
      extractCode: null,
    });
    expect(parseShareText('file:///etc/passwd')).toEqual({
      url: null,
      provider: null,
      extractCode: null,
    });
  });
});

describe('formatShareInfo', () => {
  it('按标准格式输出带提取码与有效期的分享信息', () => {
    expect(
      formatShareInfo('5th-BD 原片', 1, {
        provider: 'baidu',
        url: 'https://pan.baidu.com/s/1xxxx',
        extractCode: 'ab12',
        expiresAt: '2027-01-31',
      }),
    ).toBe(
      '5th-BD 原片 (v1)\n百度网盘：https://pan.baidu.com/s/1xxxx\n提取码：ab12\n有效期至：2027-01-31',
    );
  });

  it('无提取码与无有效期时省略对应行', () => {
    expect(
      formatShareInfo('字幕字体包', 2, {
        provider: 'mega',
        url: 'https://mega.nz/file/123',
        extractCode: null,
      }),
    ).toBe('字幕字体包 (v2)\nMEGA：https://mega.nz/file/123');
  });
});

describe('artifact schemas', () => {
  it('校验 URL 协议白名单与提取码/有效期规则', () => {
    expect(locationUrlSchema.safeParse('https://pan.baidu.com/s/123').success).toBe(true);
    expect(locationUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(locationUrlSchema.safeParse('ftp://example.com/a').success).toBe(false);

    expect(extractCodeSchema.parse('  ab12 ')).toBe('ab12');
    expect(extractCodeSchema.parse('   ')).toBeNull();
    expect(extractCodeSchema.safeParse('ab 12').success).toBe(false);

    expect(locationExpiresAtSchema.parse('2027-02-28')).toBe('2027-02-28');
    expect(locationExpiresAtSchema.safeParse('2027-02-29').success).toBe(false);

    expect(artifactNameSchema.parse('  全篇原片  ')).toBe('全篇原片');
    expect(artifactNameSchema.safeParse('   ').success).toBe(false);
  });
});
