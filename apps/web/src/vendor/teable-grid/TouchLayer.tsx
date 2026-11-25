import type { Dispatch, FC, SetStateAction } from 'react';
import { useRef } from 'react';
import {
  DEFAULT_COLUMN_RESIZE_STATE,
  DEFAULT_DRAG_STATE,
  DEFAULT_FREEZE_COLUMN_STATE,
  DEFAULT_MOUSE_STATE,
  GRID_DEFAULT,
  type IGridTheme,
} from './configs';
import type { IGridProps } from './Grid';
import { useSelection, useVisibleRegion } from './hooks';
import { LinearRowType, RegionType, SelectionRegionType } from './interface';
import type {
  ICellItem,
  ICellRegionWithData,
  IInnerCell,
  ILinearRow,
  IMouseState,
  IRange,
  IRowControlItem,
  IScrollState,
} from './interface';
import type { CoordinateManager, ImageManager, SpriteManager } from './managers';
import { emptySelection } from './managers';
import { CellRegionType, getCellRenderer } from './renderers';
import { RenderLayer } from './RenderLayer';
import { getColumnStatisticData, inRange } from './utils';

export interface ITouchLayerProps
  extends Omit<
    IGridProps,
    | 'style'
    | 'rowCount'
    | 'rowHeight'
    | 'smoothScrollX'
    | 'smoothScrollY'
    | 'freezeColumnCount'
    | 'onCopy'
    | 'onPaste'
    | 'onRowOrdered'
    | 'onColumnResize'
    | 'onColumnOrdered'
    | 'onColumnHeaderDblClick'
    | 'onColumnHeaderMenuClick'
    | 'onVisibleRegionChanged'
  > {
  theme: IGridTheme;
  width: number;
  height: number;
  forceRenderFlag: string;
  mouseState: IMouseState;
  scrollState: IScrollState;
  imageManager: ImageManager;
  spriteManager: SpriteManager;
  coordInstance: CoordinateManager;
  rowControls: IRowControlItem[];
  real2RowIndex: (index: number) => number;
  getLinearRow: (index: number) => ILinearRow;
  setMouseState: Dispatch<SetStateAction<IMouseState>>;
  setActiveCell: Dispatch<SetStateAction<ICellItem | null>>;
}

const { columnAppendBtnWidth, columnHeadHeight } = GRID_DEFAULT;

export const TouchLayer: FC<ITouchLayerProps> = (props) => {
  const {
    width,
    height,
    theme,
    columns,
    columnStatistics,
    coordInstance,
    scrollState,
    collaborators,
    searchCursor,
    highlightedRowIndex,
    mouseState,
    rowControls,
    rowControlPaddingX,
    imageManager,
    spriteManager,
    forceRenderFlag,
    rowIndexVisible,
    groupCollection,
    collapsedGroupIds,
    columnHeaderHeight,
    getCellContent,
    getLinearRow,
    real2RowIndex,
    setActiveCell,
    setMouseState,
    onRowAppend,
    onRowExpand,
    onColumnAppend,
    onColumnHeaderClick,
    onSelectionChanged,
    onColumnStatisticClick,
    onCollapsedGroupChanged,
  } = props;
  const hasAppendRow = onRowAppend != null;
  const hasAppendColumn = onColumnAppend != null;
  const { scrollTop, scrollLeft } = scrollState;
  const {
    totalHeight,
    containerHeight,
    freezeRegionWidth,
    totalWidth,
    columnInitSize,
    rowCount,
    rowInitSize,
  } = coordInstance;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tapStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const visibleRegion = useVisibleRegion(coordInstance, scrollState, forceRenderFlag);

  const { selection, setSelection } = useSelection({
    coordInstance,
    getLinearRow,
    setActiveCell,
    onSelectionChanged,
  });

  const getRangeByPosition = (x: number, y: number): [number, number] => {
    const rowIndex =
      y < 0 ? -Infinity : y <= rowInitSize ? -1 : coordInstance.getRowStartIndex(scrollTop + y);
    const columnIndex =
      x < 0
        ? -Infinity
        : scrollLeft + x > totalWidth && scrollLeft + x < totalWidth + columnAppendBtnWidth
          ? -2
          : x <= freezeRegionWidth
            ? x <= columnInitSize
              ? -1
              : coordInstance.getColumnStartIndex(x)
            : coordInstance.getColumnStartIndex(scrollLeft + x);

    return [columnIndex, rowIndex];
  };

  const onTapStyleEffect = (nextMouseState: IMouseState) => {
    setMouseState(nextMouseState);
    setTimeout(() => setMouseState(DEFAULT_MOUSE_STATE), 400);
  };

  const handleTap = (x: number, y: number) => {
    const [columnIndex, rowIndex] = getRangeByPosition(x, y);
    const posInfo = { x, y, rowIndex, columnIndex, isOutOfBounds: false };

    const statisticBoundData = getColumnStatisticData({
      columnStatistics,
      scrollState,
      coordInstance,
      getLinearRow,
      position: { x, y, rowIndex, columnIndex },
      height,
    });
    if (statisticBoundData != null) {
      const { type: _type, ...rest } = statisticBoundData;
      return onColumnStatisticClick?.(columnIndex, { ...rest });
    }

    if (rowIndex === -1 && columnIndex > -1) {
      onTapStyleEffect({ ...posInfo, type: RegionType.ColumnHeader });
      return onColumnHeaderClick?.(columnIndex, {
        x: coordInstance.getColumnRelativeOffset(columnIndex, scrollLeft),
        y: 0,
        width: coordInstance.getColumnWidth(columnIndex),
        height: columnHeadHeight,
      });
    }

    if (hasAppendColumn && rowIndex >= -1 && columnIndex === -2) {
      onTapStyleEffect({ ...posInfo, type: RegionType.AppendColumn });
      return onColumnAppend?.();
    }

    if (hasAppendRow && rowIndex === rowCount - 1 && columnIndex >= -1) {
      onTapStyleEffect({ ...posInfo, type: RegionType.AppendRow });
      return onRowAppend?.();
    }

    if (rowIndex >= 0) {
      const linearRow = getLinearRow(rowIndex);

      if (linearRow.type === LinearRowType.Group) {
        const { id } = linearRow;
        if (collapsedGroupIds == null) return onCollapsedGroupChanged?.(new Set([id]));
        if (collapsedGroupIds.has(id)) {
          const newCollapsedGroupIds = new Set(collapsedGroupIds);
          newCollapsedGroupIds.delete(id);
          return onCollapsedGroupChanged?.(newCollapsedGroupIds);
        }
        return onCollapsedGroupChanged?.(new Set([...collapsedGroupIds, id]));
      }

      if (scrollTop + y > totalHeight && !inRange(y, containerHeight, height)) {
        return;
      }

      let isPreview = false;

      if (columnIndex >= 0) {
        const cell = getCellContent([columnIndex, linearRow.realIndex]) as IInnerCell;
        const cellRenderer = getCellRenderer(cell.type);
        const onCellClick = cellRenderer.onClick;

        if (onCellClick) {
          const offsetX = coordInstance.getColumnOffset(columnIndex);
          onCellClick(
            cell as never,
            {
              width: coordInstance.getColumnWidth(columnIndex),
              height: coordInstance.getRowHeight(rowIndex),
              theme,
              hoverCellPosition: [
                columnIndex < coordInstance.freezeColumnCount
                  ? x - offsetX
                  : x - offsetX + scrollLeft,
                y - coordInstance.getRowOffset(rowIndex) + scrollTop,
              ],
              activeCellBound: null,
              isActive: false,
            },
            (cellRegion: ICellRegionWithData) => {
              if (cellRegion.type === CellRegionType.Preview) {
                isPreview = true;
              }
            },
          );
        }

        if (isPreview) return;
      }

      const range: IRange = [0, linearRow.realIndex];
      setActiveCell(range);
      setSelection(selection.set(SelectionRegionType.Cells, [range, range]));
      onTapStyleEffect({ ...posInfo, type: RegionType.Cell });
      onRowExpand?.(linearRow.realIndex);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ width, height }}
      onPointerDown={(e) => {
        tapStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
      }}
      onPointerUp={(e) => {
        const start = tapStartRef.current;
        tapStartRef.current = null;
        if (!start) return;
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx < 10 && dy < 10 && Date.now() - start.time < 450) {
          const rect = e.currentTarget.getBoundingClientRect();
          handleTap(e.clientX - rect.left, e.clientY - rect.top);
        }
      }}
    >
      <RenderLayer
        theme={theme}
        width={width}
        height={height}
        columns={columns}
        columnStatistics={columnStatistics}
        collaborators={collaborators}
        searchCursor={searchCursor}
        highlightedRowIndex={highlightedRowIndex}
        coordInstance={coordInstance}
        rowControls={rowControls}
        rowControlPaddingX={rowControlPaddingX}
        imageManager={imageManager}
        spriteManager={spriteManager}
        visibleRegion={visibleRegion}
        rowIndexVisible={rowIndexVisible}
        groupCollection={groupCollection}
        activeCell={null}
        activeCellBound={null}
        mouseState={mouseState}
        scrollState={scrollState}
        dragState={DEFAULT_DRAG_STATE}
        selection={emptySelection}
        isSelecting={false}
        forceRenderFlag={forceRenderFlag}
        columnHeaderHeight={columnHeaderHeight}
        columnFreezeState={DEFAULT_FREEZE_COLUMN_STATE}
        columnResizeState={DEFAULT_COLUMN_RESIZE_STATE}
        hoverCellPosition={null}
        hoveredColumnResizeIndex={-1}
        isRowAppendEnable={hasAppendRow}
        isColumnAppendEnable={hasAppendColumn}
        getCellContent={getCellContent}
        real2RowIndex={real2RowIndex}
        getLinearRow={getLinearRow}
      />
    </div>
  );
};
