import { CLOUD_PROVIDER_LABELS, type CloudProvider, isValidArtifactUrl } from './artifact.js';

export interface ParsedShareText {
  url: string | null;
  provider: CloudProvider | null;
  extractCode: string | null;
  suggestedName?: string;
}

const PROVIDER_DOMAINS: Array<{ provider: CloudProvider; hosts: readonly string[] }> = [
  { provider: 'baidu', hosts: ['pan.baidu.com', 'yun.baidu.com'] },
  { provider: 'aliyun', hosts: ['alipan.com', 'aliyundrive.com'] },
  { provider: 'quark', hosts: ['pan.quark.cn'] },
  { provider: 'tianyi', hosts: ['cloud.189.cn'] },
  { provider: '115', hosts: ['115.com', '115cdn.com', 'anxia.com'] },
  { provider: 'gdrive', hosts: ['drive.google.com', 'docs.google.com'] },
  { provider: 'mega', hosts: ['mega.nz', 'mega.co.nz'] },
  { provider: 'onedrive', hosts: ['1drv.ms', 'onedrive.live.com', 'sharepoint.com'] },
];

function hostMatches(hostname: string, target: string): boolean {
  return hostname === target || hostname.endsWith(`.${target}`);
}

const HTTP_URL_HOST_RE = /^https?:\/\/(?:[^/?#@]+@)?([^/?#:]+)/i;

/**
 * 根据合法 http/https URL 自动识别网盘服务商；未知域名一律返回 'other'。
 */
export function detectCloudProvider(url: string): CloudProvider {
  const trimmed = url.trim();
  if (!isValidArtifactUrl(trimmed)) return 'other';
  const match = HTTP_URL_HOST_RE.exec(trimmed);
  if (!match?.[1]) return 'other';
  const hostname = match[1].toLowerCase();
  for (const entry of PROVIDER_DOMAINS) {
    if (entry.hosts.some((h) => hostMatches(hostname, h))) {
      return entry.provider;
    }
  }
  return 'other';
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"{}|\\^`[\]（）【】《》「」『』“”‘’，。、；：！？]+/i;
const TRAILING_PUNCT_RE = /[.,;:!?)'"\]}>，。、；：！？）】》」』”’]+$/;

const EXPLICIT_CODE_RE = /(?:提取码|访问码|密码|取件码)\s*[:：]?\s*([A-Za-z0-9]{4,12})/i;
const QUERY_PWD_RE = /[?&]pwd=([A-Za-z0-9]{4,12})(?:&|#|$)/i;
const LOOSE_PWD_RE = /\bpwd\s*=\s*([A-Za-z0-9]{4,12})\b/i;

const SUGGESTED_NAME_PATTERNS = [
  /通过网盘分享的文件\s*[:：]\s*([^\r\n]{1,80})/,
  /我用夸克网盘分享了[「『《"]([^」』》"\r\n]{1,80})[」』》"]/,
  /[「『《]([^」』》\r\n]{2,80})[」』》]/,
];

function cleanUrlCandidate(candidate: string): string {
  let out = candidate.trim();
  while (out.length > 0 && TRAILING_PUNCT_RE.test(out)) {
    out = out.replace(TRAILING_PUNCT_RE, '');
  }
  return out;
}

/**
 * 从整段 QQ 群 / 网盘分享文本中解析首个合法 http/https 链接、服务商与提取码。
 * 纯函数、零网络请求；拒绝 javascript:/data:/file: 等非 http/https 协议。
 */
export function parseShareText(raw: string): ParsedShareText {
  const text = raw.normalize('NFC');
  let url: string | null = null;
  let provider: CloudProvider | null = null;

  const urlMatch = URL_IN_TEXT_RE.exec(text);
  if (urlMatch) {
    const cleaned = cleanUrlCandidate(urlMatch[0]);
    if (isValidArtifactUrl(cleaned)) {
      url = cleaned;
      provider = detectCloudProvider(cleaned);
    }
  }

  let extractCode: string | null = null;
  const explicitMatch = EXPLICIT_CODE_RE.exec(text);
  if (explicitMatch?.[1]) {
    extractCode = explicitMatch[1];
  } else if (url) {
    const urlPwd = QUERY_PWD_RE.exec(url);
    if (urlPwd?.[1]) {
      extractCode = urlPwd[1];
    }
  }
  if (!extractCode) {
    const loosePwd = LOOSE_PWD_RE.exec(text);
    if (loosePwd?.[1]) {
      extractCode = loosePwd[1];
    }
  }

  let suggestedName: string | undefined;
  for (const pat of SUGGESTED_NAME_PATTERNS) {
    const m = pat.exec(text);
    const candidate = m?.[1]?.trim();
    if (candidate && !candidate.includes('http://') && !candidate.includes('https://')) {
      suggestedName = candidate;
      break;
    }
  }

  return suggestedName
    ? { url, provider, extractCode, suggestedName }
    : { url, provider, extractCode };
}

/**
 * 生成适合直接粘贴回 QQ 群的完整分享信息。
 */
export function formatShareInfo(
  artifactName: string,
  versionNumber: number | null,
  loc: {
    provider: CloudProvider | null;
    url: string | null;
    extractCode: string | null;
    expiresAt?: string | null;
  },
): string {
  const lines: string[] = [];
  const header = versionNumber !== null ? `${artifactName} (v${versionNumber})` : artifactName;
  lines.push(header);

  const providerLabel = loc.provider ? CLOUD_PROVIDER_LABELS[loc.provider] : '链接';
  if (loc.url) {
    lines.push(`${providerLabel}：${loc.url}`);
  }
  if (loc.extractCode) {
    lines.push(`提取码：${loc.extractCode}`);
  }
  if (loc.expiresAt) {
    lines.push(`有效期至：${loc.expiresAt}`);
  }
  return lines.join('\n');
}
