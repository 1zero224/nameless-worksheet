import { Loader2, Square } from 'lucide-react';
import { useMemo } from 'react';
import type { ICellItem, IColumnLoading, IScrollState } from '../interface';
import type { CoordinateManager } from '../managers';

export interface ILoadingIndicatorProps {
  cellLoadings: ICellItem[];
  columnLoadings: IColumnLoading[];
  coordInstance: CoordinateManager;
  scrollState: IScrollState;
  real2RowIndex: (index: number) => number;
}

export const LoadingIndicator = (props: ILoadingIndicatorProps) => {
  const { cellLoadings, columnLoadings, coordInstance, scrollState, real2RowIndex } = props;

  const uniqueCellLoadings = useMemo(() => {
    const seen = new Set<string>();
    return cellLoadings.filter(([columnIndex, realRowIndex]) => {
      const key = `${columnIndex}-${realRowIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [cellLoadings]);

  if (!uniqueCellLoadings.length && !columnLoadings.length) return null;

  const { scrollLeft, scrollTop } = scrollState;
  const { rowInitSize, freezeColumnCount, freezeRegionWidth, containerWidth, containerHeight } =
    coordInstance;

  return (
    <div className="pointer-events-none absolute start-0 top-0">
      {columnLoadings.map(({ index, progress, onCancel }) => {
        const columnWidth = coordInstance.getColumnWidth(index);
        const columnOffset = coordInstance.getColumnRelativeOffset(index, scrollLeft);
        const isFreeze = index < freezeColumnCount;

        const isColumnVisible =
          isFreeze ||
          (columnOffset + columnWidth - 24 >= freezeRegionWidth && columnOffset <= containerWidth);

        if (!isColumnVisible) return null;

        return (
          <div
            key={`loading-${index}`}
            className="absolute rounded-sm"
            style={{
              left: columnOffset,
              top: 0,
              width: columnWidth,
              height: 24,
            }}
          >
            <div
              className="pointer-events-auto absolute end-1 top-1 cursor-pointer rounded-full bg-background"
              onClick={onCancel}
            >
              <div
                className="absolute end-0 top-0 flex size-6 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(currentColor ${progress * 360}deg, rgba(0,0,0,0.1) 0deg)`,
                }}
              >
                <div className="flex size-5 items-center justify-center rounded-full bg-background">
                  <Square className="size-3" />
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {uniqueCellLoadings.map(([columnIndex, realRowIndex]) => {
        if (realRowIndex >= coordInstance.pureRowCount) return null;
        const rowIndex = real2RowIndex(realRowIndex);
        if (rowIndex == null) return null;

        const rowHeight = coordInstance.getRowHeight(rowIndex);
        const rowOffset = coordInstance.getRowOffset(rowIndex);
        const columnWidth = coordInstance.getColumnWidth(columnIndex);
        const columnOffset = coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft);

        const y = rowOffset - scrollTop;
        const isFreeze = columnIndex < freezeColumnCount;
        const isColumnVisible =
          isFreeze ||
          (columnOffset + columnWidth - 24 >= freezeRegionWidth && columnOffset <= containerWidth);
        const isRowVisible = y >= rowInitSize - 4 && y <= containerHeight - rowInitSize + 4;

        if (!isColumnVisible || !isRowVisible) return null;

        return (
          <div
            key={`loading-${columnIndex}-${realRowIndex}`}
            className="absolute rounded-sm"
            style={{
              left: columnOffset,
              top: rowOffset - scrollTop,
              width: columnWidth,
              height: rowHeight,
            }}
          >
            <div className="absolute end-1 top-1 rounded-full bg-white p-1">
              <Loader2 className="size-4 animate-spin text-zinc-500" />
            </div>
          </div>
        );
      })}
    </div>
  );
};
