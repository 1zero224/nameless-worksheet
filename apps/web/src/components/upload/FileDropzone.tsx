import { DEFAULT_MAX_FILE_BYTES, formatFileSize } from '@nw/shared';
import { FileUp, X } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react';
import { cn } from '@/components/ui/primitives.js';

export function FileDropzone({
  file,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  error,
  onSelectFile,
  onError,
  testId = 'file-dropzone-input',
}: {
  file: File | null;
  maxFileBytes?: number;
  error?: string | null;
  onSelectFile: (file: File | null) => void;
  onError?: (message: string | null) => void;
  testId?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const validateAndAccept = (picked: File | null) => {
    onError?.(null);
    if (!picked) {
      onSelectFile(null);
      return;
    }
    if (picked.size <= 0) {
      onError?.('不支持上传 0 字节空文件');
      onSelectFile(null);
      return;
    }
    if (picked.size > maxFileBytes) {
      onError?.(`文件大小超过 ${formatFileSize(maxFileBytes)} 上限，请改用网盘链接`);
      onSelectFile(null);
      return;
    }
    onSelectFile(picked);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    validateAndAccept(picked);
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const picked = e.dataTransfer.files?.[0] ?? null;
    validateAndAccept(picked);
  };

  return (
    <div className="space-y-1.5">
      <input
        ref={inputRef}
        type="file"
        data-testid={testId}
        onChange={handleChange}
        className="sr-only"
      />

      {file ? (
        <div
          data-testid="file-dropzone-selected"
          className="flex items-center justify-between gap-2 rounded-lg border border-black/[0.1] bg-[#fafafa] px-3 py-2.5"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-900 text-white">
              <FileUp className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-zinc-900" title={file.name}>
                {file.name}
              </div>
              <div className="text-[11px] text-zinc-500 tabular-nums">
                {formatFileSize(file.size)}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-900 cursor-pointer"
            >
              更换
            </button>
            <button
              type="button"
              aria-label="清除所选文件"
              onClick={() => validateAndAccept(null)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-800 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="file-dropzone-area"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => handleDrop(e as unknown as DragEvent<HTMLDivElement>)}
          className={cn(
            'flex w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors cursor-pointer',
            dragging
              ? 'border-zinc-900 bg-zinc-50'
              : error
                ? 'border-red-300 bg-red-50/40'
                : 'border-black/[0.15] bg-[#fafafa] hover:border-zinc-400 hover:bg-zinc-50/80',
          )}
        >
          <FileUp className="h-5 w-5 text-zinc-400" strokeWidth={1.75} />
          <div className="mt-1.5 text-xs font-medium text-zinc-800">
            拖拽文件到此处，或点击选择文件
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            单文件最大 {formatFileSize(maxFileBytes)} · 大文件自动启用断点续传
          </div>
        </button>
      )}
    </div>
  );
}
