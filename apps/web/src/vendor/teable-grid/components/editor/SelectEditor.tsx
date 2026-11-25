import { Check } from 'lucide-react';
import { noop } from 'lodash';
import type { ForwardRefRenderFunction } from 'react';
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ISelectCell } from '../../renderers';
import { useIsTouchDevice } from '../../utils/compat';
import type { IEditorProps, IEditorRef } from './EditorContainer';

const SelectEditorBase: ForwardRefRenderFunction<
  IEditorRef<ISelectCell>,
  IEditorProps<ISelectCell>
> = (props, ref) => {
  const { cell, isEditing, style, onChange, setEditing, theme } = props;
  const { data, isMultiple, choiceSorted = [], choiceMap = {} } = cell;
  const [values, setValues] = useState(data);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { cellOptionBg, cellOptionTextColor } = theme;
  const isTouchDevice = useIsTouchDevice();

  useImperativeHandle(ref, () => ({
    focus: () => {
      if (!isTouchDevice) inputRef.current?.focus();
    },
    setValue: (nextData: ISelectCell['data']) => setValues(nextData),
    saveValue: noop,
  }));

  const onSelect = (v: string, id?: string) => {
    const existIndex = values.findIndex((item) => {
      if (typeof item === 'string') return item === v;
      return item.title === v;
    });
    const newCellValue =
      existIndex > -1
        ? values.filter((_, index) => index !== existIndex)
        : [...values, id ? { id, title: v } : v];
    if (!isMultiple) {
      const value = newCellValue.length ? newCellValue[newCellValue.length - 1] : null;
      setTimeout(() => setEditing?.(false));
      setValues(value ? [value] : []);
      return onChange?.(value);
    }
    const value = newCellValue.length ? newCellValue : null;
    setValues(value || []);
    return onChange?.(value);
  };

  const filtered = query.trim()
    ? choiceSorted.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
    : choiceSorted;

  return (
    <div
      className="rounded-md border border-zinc-200 bg-white p-1.5 shadow-md"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索选项…"
        className="mb-1.5 w-full rounded border border-zinc-200 px-2 py-1 text-xs outline-none focus:border-zinc-400"
      />
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {isEditing && filtered.length === 0 && (
          <div className="py-2 text-center text-xs text-zinc-400">无匹配项</div>
        )}
        {isEditing &&
          filtered.map(({ name, id }) => {
            const selected = values?.some((v) => (typeof v === 'string' ? v === name : v.title === name));
            return (
              <button
                type="button"
                key={id}
                onClick={() => onSelect(name, id)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-zinc-100 cursor-pointer"
              >
                <span
                  className="truncate rounded px-1.5 py-0.5 text-xs"
                  style={{
                    backgroundColor:
                      (choiceMap?.[id] ?? choiceMap?.[name])?.backgroundColor ?? cellOptionBg,
                    color: (choiceMap?.[id] ?? choiceMap?.[name])?.color ?? cellOptionTextColor,
                  }}
                >
                  {name}
                </span>
                {selected && <Check className="ms-2 size-3.5 text-zinc-700" />}
              </button>
            );
          })}
      </div>
    </div>
  );
};

export const SelectEditor = forwardRef(SelectEditorBase);
