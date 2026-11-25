import type { ChangeEvent, ForwardRefRenderFunction, KeyboardEvent, RefObject } from 'react';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { GRID_DEFAULT } from '../../configs';
import type { ILinkCell, INumberCell, ITextCell } from '../../renderers';
import { CellType } from '../../renderers';
import { KeyCode, useContentDir } from '../../utils/compat';
import type { IEditorProps, IEditorRef } from './EditorContainer';

const { rowHeight: defaultRowHeight } = GRID_DEFAULT;

const TextEditorBase: ForwardRefRenderFunction<
  IEditorRef<ITextCell | INumberCell>,
  IEditorProps<ITextCell | INumberCell | ILinkCell>
> = (props, ref) => {
  const { cell, rect, style, theme, isEditing, onChange } = props;
  const { cellLineColorActived } = theme;
  const { width, height } = rect;
  const { displayData, type } = cell;
  const needWrap = (cell as ITextCell)?.isWrap;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [value, setValueInner] = useState(displayData);
  const contentDir = useContentDir();

  const saveValue = () => {
    if (value === displayData || !isEditing) return;
    if (type === CellType.Number) {
      onChange?.(Number(value));
    } else {
      onChange?.(typeof value === 'string' ? value.trim() : value);
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    setValue: (nextVal: string | number | null | undefined) => setValueInner(String(nextVal ?? '')),
    saveValue,
  }));

  const onChangeInner = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValueInner(e.target.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const { keyCode, shiftKey } = event;
    if (keyCode === KeyCode.Enter && !shiftKey) {
      event.preventDefault();
    }
    if (keyCode === KeyCode.Enter && shiftKey) {
      event.stopPropagation();
    }
  };

  const attachStyle = useMemo(() => {
    const nextStyle: React.CSSProperties = {
      width: width + 4,
      minHeight: height + 4,
      height: needWrap ? 'auto' : height + 4,
      marginLeft: -2,
      marginTop: -2,
      textAlign: type === CellType.Number ? 'right' : 'start',
    };
    if (height > defaultRowHeight) {
      nextStyle.paddingBottom = height - defaultRowHeight;
    }
    return nextStyle;
  }, [type, height, width, needWrap]);

  return (
    <>
      {needWrap ? (
        <div
          style={{
            ...style,
            ...attachStyle,
            paddingBottom: 16,
            border: `2px solid ${cellLineColorActived}`,
          }}
          className="relative rounded-md bg-white"
        >
          <textarea
            ref={inputRef as RefObject<HTMLTextAreaElement>}
            dir={contentDir}
            rows={2}
            className="w-full resize-none rounded border-none bg-white px-2 pt-1 text-[13px] leading-[1.4rem] focus-visible:outline-none"
            value={value}
            onBlur={saveValue}
            onKeyDown={onKeyDown}
            onChange={onChangeInner}
          />
        </div>
      ) : (
        <input
          ref={inputRef as RefObject<HTMLInputElement>}
          dir={contentDir}
          style={{
            border: `2px solid ${cellLineColorActived}`,
            ...style,
            ...attachStyle,
          }}
          value={value}
          className="cursor-text rounded-xs bg-white px-2 text-[13px] outline-none"
          onChange={onChangeInner}
          onBlur={saveValue}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </>
  );
};

export const TextEditor = forwardRef(TextEditorBase);
