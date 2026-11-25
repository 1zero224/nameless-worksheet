import { AlertCircle, RefreshCcw, X } from 'lucide-react';
import type { ICellError, IScrollState } from '../interface';
import type { CoordinateManager } from '../managers';

export interface IErrorIndicatorProps {
  cellErrors: ICellError[];
  coordInstance: CoordinateManager;
  scrollState: IScrollState;
  real2RowIndex: (index: number) => number;
}

export const ErrorIndicator = (props: IErrorIndicatorProps) => {
  const { cellErrors, coordInstance, scrollState, real2RowIndex } = props;

  if (!cellErrors.length) return null;

  const { scrollLeft, scrollTop } = scrollState;
  const { rowInitSize, freezeColumnCount, freezeRegionWidth, containerWidth, containerHeight } =
    coordInstance;

  return (
    <div className="pointer-events-none absolute start-0 top-0">
      {cellErrors.map(({ cellItem, errorMsg, onRetry, onDismiss }) => {
        const [columnIndex, realRowIndex] = cellItem;
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

        const key = `error-${columnIndex}-${realRowIndex}`;

        return (
          <div
            key={key}
            className="absolute"
            style={{
              left: columnOffset,
              top: rowOffset - scrollTop,
              width: columnWidth,
              height: rowHeight,
            }}
          >
            <div
              title={errorMsg}
              className="pointer-events-auto absolute end-1 top-1 flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700"
            >
              <AlertCircle className="size-3.5 text-red-500" />
              {onRetry && (
                <button
                  type="button"
                  title="重试"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry();
                  }}
                  className="hover:text-red-900 cursor-pointer"
                >
                  <RefreshCcw className="size-3" />
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismiss();
                  }}
                  className="hover:text-red-900 cursor-pointer"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
