import { useEffect } from 'react';
import type { IEditorContainerProps, IEditorRef } from '../components';
import type { IRange } from '../interface';
import { SelectionRegionType } from '../interface';

interface ISelectionKeyboardProps
  extends Omit<
    IEditorContainerProps,
    | 'theme'
    | 'onChange'
    | 'scrollState'
    | 'activeCellBound'
    | 'real2RowIndex'
    | 'getCellContent'
    | 'onCellActivated'
  > {
  editorRef: React.MutableRefObject<IEditorRef | null>;
}

export const useKeyboardSelection = (props: ISelectionKeyboardProps) => {
  const {
    isEditing,
    activeCell,
    coordInstance,
    selection,
    scrollToItem,
    setEditing,
    setActiveCell,
    setSelection,
    onUndo,
    onRedo,
    onDelete,
    onRowExpand,
    editorRef,
    scrollBy,
    disableEnterMoveDown,
  } = props;
  const { pureRowCount, columnCount } = coordInstance;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const insideGrid = Boolean(target.closest('[data-t-grid-container]'));
        const insideDialog = Boolean(
          target.closest('[role="dialog"]') ||
            target.closest('[data-radix-popper-content-wrapper]') ||
            target.closest('[role="menu"]'),
        );
        if (insideDialog) return;
        if (
          !insideGrid &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable)
        ) {
          return;
        }
      }

      const mod = e.metaKey || e.ctrlKey;
      const key = e.key;

      // Undo / Redo
      if (mod && !isEditing && selection.type !== SelectionRegionType.None) {
        if (key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          onUndo?.();
          return;
        }
        if ((key.toLowerCase() === 'z' && e.shiftKey) || key.toLowerCase() === 'y') {
          e.preventDefault();
          onRedo?.();
          return;
        }
        if (key.toLowerCase() === 'a' && activeCell) {
          e.preventDefault();
          const ranges: IRange[] = [
            [0, 0],
            [Math.max(0, columnCount - 1), Math.max(0, pureRowCount - 1)],
          ];
          setSelection(selection.setRanges(ranges));
          return;
        }
      }

      if (!activeCell) return;

      // Arrow keys
      if (
        !isEditing &&
        (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight')
      ) {
        const baseRange = selection.ranges[e.shiftKey ? 1 : 0] ?? selection.ranges[0];
        if (!baseRange) return;
        e.preventDefault();
        let [columnIndex, rowIndex] = baseRange;

        if (mod) {
          if (key === 'ArrowUp') rowIndex = 0;
          else if (key === 'ArrowDown') rowIndex = Math.max(0, pureRowCount - 1);
          else if (key === 'ArrowLeft') columnIndex = 0;
          else if (key === 'ArrowRight') columnIndex = Math.max(0, columnCount - 1);
        } else {
          if (key === 'ArrowUp') rowIndex = Math.max(rowIndex - 1, 0);
          else if (key === 'ArrowDown') rowIndex = Math.min(rowIndex + 1, Math.max(0, pureRowCount - 1));
          else if (key === 'ArrowLeft') columnIndex = Math.max(columnIndex - 1, 0);
          else if (key === 'ArrowRight') columnIndex = Math.min(columnIndex + 1, Math.max(0, columnCount - 1));
        }

        const newRange: IRange = [columnIndex, rowIndex];
        const firstRange = selection.ranges[0] ?? newRange;
        const ranges: IRange[] = e.shiftKey ? [firstRange, newRange] : [newRange, newRange];
        scrollToItem([columnIndex, rowIndex]);
        if (!e.shiftKey) setActiveCell(newRange);
        setSelection(selection.setRanges(ranges));
        return;
      }

      // Tab / Shift+Tab
      if (key === 'Tab') {
        const firstRange = selection.ranges[0];
        if (!firstRange) return;
        e.preventDefault();
        const [columnIndex, rowIndex] = firstRange;
        const newColumnIndex = e.shiftKey
          ? Math.max(columnIndex - 1, 0)
          : Math.min(columnIndex + 1, Math.max(0, columnCount - 1));
        const newRange: IRange = [newColumnIndex, rowIndex];
        editorRef.current?.saveValue?.();
        scrollToItem([newColumnIndex, rowIndex]);
        setEditing(false);
        setActiveCell(newRange);
        setSelection(selection.setRanges([newRange, newRange]));
        return;
      }

      // PageUp / PageDown
      if (!isEditing && (key === 'PageUp' || key === 'PageDown')) {
        e.preventDefault();
        const delta = coordInstance.containerHeight - coordInstance.rowInitSize - 1;
        scrollBy(0, key === 'PageUp' ? -delta : delta);
        return;
      }

      // F2 / Delete / Backspace
      if (!isEditing && key === 'F2') {
        e.preventDefault();
        setEditing(true);
        return;
      }
      if (!isEditing && (key === 'Delete' || key === 'Backspace')) {
        onDelete?.(selection);
        return;
      }

      // Enter
      if (key === 'Enter') {
        e.preventDefault();
        if (isEditing) {
          const base = selection.ranges[0];
          if (!base) return;
          const [columnIndex, rowIndex] = selection.isColumnSelection ? [base[0], 0] : base;
          const nextRowIndex = disableEnterMoveDown
            ? rowIndex
            : Math.min(rowIndex + 1, Math.max(0, pureRowCount - 1));
          const newRange: IRange = [columnIndex, nextRowIndex];
          editorRef.current?.saveValue?.();
          setTimeout(() => {
            setSelection(selection.set(SelectionRegionType.Cells, [newRange, newRange]));
            setActiveCell(newRange);
            setEditing(false);
            scrollToItem(newRange);
          });
        } else {
          setEditing(true);
        }
        return;
      }

      // Escape
      if (key === 'Escape') {
        if (isEditing) {
          e.preventDefault();
          setEditing(false);
        }
        return;
      }

      // Space
      if (!isEditing && key === ' ') {
        e.preventDefault();
        const [, rowIndex] = activeCell;
        onRowExpand?.(rowIndex);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isEditing,
    activeCell,
    coordInstance,
    selection,
    pureRowCount,
    columnCount,
    scrollToItem,
    setEditing,
    setActiveCell,
    setSelection,
    onUndo,
    onRedo,
    onDelete,
    onRowExpand,
    editorRef,
    scrollBy,
    disableEnterMoveDown,
  ]);
};
