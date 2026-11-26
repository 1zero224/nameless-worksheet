import { CLOUD_PROVIDER_LABELS, type ParsedShareText, parseShareText } from '@nw/shared';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/components/ui/primitives.js';

export function SharePasteInput({
  onParsed,
  className,
}: {
  onParsed: (parsed: ParsedShareText) => void;
  className?: string;
}) {
  const [raw, setRaw] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  const handleChange = (val: string) => {
    setRaw(val);
    const trimmed = val.trim();
    if (!trimmed) {
      setHint(null);
      return;
    }
    const parsed = parseShareText(trimmed);
    if (parsed.url || parsed.extractCode) {
      onParsed(parsed);
      const parts: string[] = [];
      if (parsed.provider) parts.push(CLOUD_PROVIDER_LABELS[parsed.provider]);
      if (parsed.extractCode) parts.push(`提取码 ${parsed.extractCode}`);
      setHint(
        parts.length > 0 ? `已自动识别 ${parts.join('、')}，可按需修改` : '已提取链接，可按需修改',
      );
    } else {
      setHint('未检测到合法的 http/https 链接，请手动填写下方字段');
    }
  };

  return (
    <div
      className={cn(
        'rounded-lg border border-black/[0.08] bg-[#fafafa] p-2.5 space-y-1.5',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor="share-paste-textarea"
          className="inline-flex items-center gap-1 text-xs font-medium text-zinc-700"
        >
          <Sparkles className="h-3.5 w-3.5 text-zinc-500" />
          粘贴网盘分享文本（可选，自动解析链接与提取码）
        </label>
        {raw && (
          <button
            type="button"
            onClick={() => {
              setRaw('');
              setHint(null);
            }}
            className="text-[11px] text-zinc-400 hover:text-zinc-700 cursor-pointer"
          >
            清空
          </button>
        )}
      </div>
      <textarea
        id="share-paste-textarea"
        data-testid="share-paste-input"
        rows={2}
        value={raw}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="直接粘贴百度/夸克/阿里/天翼/115/MEGA 等整段分享文案，自动提取链接、服务商与提取码…"
        className="block w-full resize-none rounded-md border border-black/[0.1] bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none"
      />
      {hint && (
        <div data-testid="share-paste-hint" className="text-[11px] font-medium text-emerald-700">
          {hint}
        </div>
      )}
    </div>
  );
}
