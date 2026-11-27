import type {
  ForwardRefRenderFunction,
  MutableRefObject,
  ReactNode,
  RefObject,
  UIEvent,
} from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { IGridProps } from './Grid';
import { getHorizontalRangeInfo, getVerticalRangeInfo } from './hooks';
import type { ILinearRow, IScrollState } from './interface';
import type { CoordinateManager } from './managers';
import type { ITimeoutID } from './utils';
import { getWheelDelta } from './utils';
import { cn } from './utils/compat';
import { cancelTimeout, requestTimeout } from './utils/utils';

export interface ScrollerProps
  extends Pick<
    IGridProps,
    | 'smoothScrollX'
    | 'smoothScrollY'
    | 'scrollBarVisible'
    | 'onScrollChanged'
    | 'onVisibleRegionChanged'
  > {
  coordInstance: CoordinateManager;
  containerWidth: number;
  containerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  left?: number;
  top?: number;
  scrollEnable?: boolean;
  scrollState: IScrollState;
  getLinearRow: (index: number) => ILinearRow;
  setScrollState: React.Dispatch<React.SetStateAction<IScrollState>>;
}

export interface ScrollerRef {
  scrollTo: (sl?: number, st?: number) => void;
  scrollBy: (deltaX: number, deltaY: number) => void;
}

const InfiniteScrollerBase: ForwardRefRenderFunction<ScrollerRef, ScrollerProps> = (props, ref) => {
  const {
    coordInstance,
    containerWidth,
    containerHeight,
    scrollWidth,
    scrollHeight,
    left = 0,
    top = 0,
    containerRef,
    smoothScrollX,
    smoothScrollY,
    scrollBarVisible,
    scrollEnable = true,
    scrollState,
    getLinearRow,
    setScrollState,
    onScrollChanged,
    onVisibleRegionChanged,
  } = props;

  useImperativeHandle(ref, () => ({
    scrollTo: (sl?: number, st?: number) => {
      if (horizontalScrollRef.current && sl != null) {
        horizontalScrollRef.current.scrollLeft = sl;
      }
      if (verticalScrollRef.current && st != null) {
        const el = verticalScrollRef.current;
        const scrollableHeight = el.scrollHeight - el.clientHeight;
        let virtualOffsetY = 0;
        if (scrollableHeight > 0 && scrollHeight > el.scrollHeight + 5) {
          const prog = st / (scrollHeight - el.clientHeight);
          const actualScrollTop = scrollableHeight * prog;
          virtualOffsetY = actualScrollTop - st;
        }
        verticalScrollRef.current.scrollTop = st + virtualOffsetY;
      }
    },
    scrollBy: (deltaX: number, deltaY: number) => {
      if (horizontalScrollRef.current) {
        horizontalScrollRef.current.scrollLeft += deltaX;
      }
      if (verticalScrollRef.current) {
        verticalScrollRef.current.scrollTop += deltaY;
      }
    },
  }));

  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const verticalScrollRef = useRef<HTMLDivElement | null>(null);
  const resetScrollingTimeoutID = useRef<ITimeoutID | null>(null);
  const offsetY = useRef(0);
  const lastScrollTop = useRef(0);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);

  const resetScrolling = useCallback(() => {
    setScrollState((prev) => ({ ...prev, isScrolling: false }));
    resetScrollingTimeoutID.current = null;
  }, [setScrollState]);

  const resetScrollingDebounced = useCallback(() => {
    if (resetScrollingTimeoutID.current !== null) {
      cancelTimeout(resetScrollingTimeoutID.current);
    }
    resetScrollingTimeoutID.current = requestTimeout(resetScrolling, 200);
  }, [resetScrolling]);

  const onScroll = (e: UIEvent<HTMLDivElement>, direction: 'horizontal' | 'vertical') => {
    if (!verticalScrollRef.current || !horizontalScrollRef.current) {
      return;
    }
    const el = e.target as HTMLElement;
    const { scrollTop: newScrollTop, scrollLeft } = el;
    const { rowInitSize, columnInitSize } = coordInstance;

    let scrollProps: { [key: string]: number } = {};

    if (direction === 'vertical') {
      const delta = lastScrollTop.current - newScrollTop;
      const scrollableHeight = el.scrollHeight - el.clientHeight;
      lastScrollTop.current = newScrollTop;

      if (
        scrollableHeight > 0 &&
        (Math.abs(delta) > 2000 || newScrollTop === 0 || newScrollTop === scrollableHeight) &&
        scrollHeight > el.scrollHeight + 5
      ) {
        const prog = newScrollTop / scrollableHeight;
        const recomputed = (scrollHeight - el.clientHeight) * prog;
        offsetY.current = recomputed - newScrollTop;
      }
      const scrollTop = newScrollTop + offsetY.current;
      const rowIndex = coordInstance.getRowStartIndex(scrollTop);
      const rowOffset = coordInstance.getRowOffset(rowIndex);

      scrollProps = {
        scrollTop: !smoothScrollY ? rowOffset - rowInitSize : scrollTop,
      };
    }

    if (direction === 'horizontal') {
      const colIndex = coordInstance.getColumnStartIndex(scrollLeft);
      const colOffset = coordInstance.getColumnOffset(colIndex);
      scrollProps = {
        scrollLeft: !smoothScrollX ? colOffset - columnInitSize : scrollLeft,
      };
    }

    const { startRowIndex, stopRowIndex } = getVerticalRangeInfo(
      coordInstance,
      scrollProps.scrollTop ?? scrollState.scrollTop,
    );
    const { startColumnIndex, stopColumnIndex } = getHorizontalRangeInfo(
      coordInstance,
      scrollProps.scrollLeft ?? scrollState.scrollLeft,
    );

    const realStartRowIndex = getLinearRow(startRowIndex).realIndex;
    const realStopRowIndex = getLinearRow(stopRowIndex).realIndex;

    onVisibleRegionChanged?.({
      x: startColumnIndex,
      y: realStartRowIndex,
      width: stopColumnIndex - startColumnIndex,
      height: realStopRowIndex - realStartRowIndex,
    });
    onScrollChanged?.(
      scrollProps.scrollLeft ?? scrollState.scrollLeft,
      scrollProps.scrollTop ?? scrollState.scrollTop,
    );

    setScrollState((prev) => ({
      ...prev,
      ...scrollProps,
      isScrolling: true,
    }));
    resetScrollingDebounced();
  };

  const scrollHandler = useCallback((deltaX: number, deltaY: number) => {
    if (horizontalScrollRef.current) {
      horizontalScrollRef.current.scrollLeft += deltaX;
    }
    if (verticalScrollRef.current) {
      verticalScrollRef.current.scrollTop += deltaY;
    }
  }, []);

  const onWheel = useCallback(
    (event: Event) => {
      if (!scrollEnable) return;
      event.preventDefault();
      const [fixedDeltaX, fixedDeltaY] = getWheelDelta({
        event: event as WheelEvent,
        pageHeight: coordInstance.containerHeight - coordInstance.rowInitSize - 1,
        lineHeight: coordInstance.rowHeight,
      });
      scrollHandler(fixedDeltaX, fixedDeltaY);
    },
    [scrollEnable, scrollHandler, coordInstance],
  );

  const onTouchStart = useCallback((e: Event) => {
    const te = e as TouchEvent;
    const t = te.touches[0];
    if (t) {
      lastTouchRef.current = { x: t.clientX, y: t.clientY };
    }
  }, []);

  const onTouchMove = useCallback(
    (e: Event) => {
      const te = e as TouchEvent;
      const t = te.touches[0];
      if (!t || !lastTouchRef.current) return;
      const dx = lastTouchRef.current.x - t.clientX;
      const dy = lastTouchRef.current.y - t.clientY;
      lastTouchRef.current = { x: t.clientX, y: t.clientY };
      scrollHandler(dx, dy);
    },
    [scrollHandler],
  );

  const onTouchEnd = useCallback(() => {
    lastTouchRef.current = null;
  }, []);

  const placeholderElements: ReactNode[] = useMemo(() => {
    let h = 0;
    let key = 0;
    const res: ReactNode[] = [];
    while (h < scrollHeight) {
      const curH = Math.min(5000000, scrollHeight - h);
      res.push(<div key={key++} style={{ width: 0, height: curH }} />);
      h += curH;
    }
    return res;
  }, [scrollHeight]);

  const wheelHandlerRef = useRef(onWheel);
  wheelHandlerRef.current = onWheel;
  const touchStartRef = useRef(onTouchStart);
  touchStartRef.current = onTouchStart;
  const touchMoveRef = useRef(onTouchMove);
  touchMoveRef.current = onTouchMove;
  const touchEndRef = useRef(onTouchEnd);
  touchEndRef.current = onTouchEnd;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (ev: WheelEvent) => wheelHandlerRef.current(ev);
    const handleTouchStart = (ev: TouchEvent) => touchStartRef.current(ev);
    const handleTouchMove = (ev: TouchEvent) => touchMoveRef.current(ev);
    const handleTouchEnd = () => touchEndRef.current();

    el.addEventListener('wheel', handleWheel, { passive: false });
    el.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true, capture: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
    return () => {
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart, { capture: true });
      el.removeEventListener('touchmove', handleTouchMove, { capture: true });
      el.removeEventListener('touchend', handleTouchEnd, { capture: true });
    };
  }, [containerRef]);

  return (
    <>
      <div
        ref={horizontalScrollRef}
        data-t-grid-scrollbar="horizontal"
        className={cn(
          'absolute bottom-[2px] start-0 z-20 h-3.5 cursor-pointer overflow-y-hidden overflow-x-auto will-change-transform',
          !scrollBarVisible && 'pointer-events-none opacity-0',
        )}
        style={{
          left,
          width: Math.max(0, containerWidth - left),
        }}
        onScroll={(e) => onScroll(e, 'horizontal')}
      >
        <div
          className="absolute"
          style={{
            width: scrollWidth,
            height: 1,
          }}
        />
      </div>
      <div
        ref={verticalScrollRef}
        data-t-grid-scrollbar="vertical"
        className={cn(
          'absolute end-[2px] z-20 w-3.5 cursor-pointer overflow-x-hidden overflow-y-auto will-change-transform',
          !scrollBarVisible && 'pointer-events-none opacity-0',
        )}
        style={{
          top,
          height: Math.max(0, containerHeight - top),
        }}
        onScroll={(e) => onScroll(e, 'vertical')}
      >
        <div className="flex w-px shrink-0 flex-col">{placeholderElements}</div>
      </div>
    </>
  );
};

export const InfiniteScroller = forwardRef(InfiniteScrollerBase);
