import { GRID_DEFAULT } from '../../configs';
import type { IRectangle } from '../../interface';
import { inRange } from '../../utils';
import { LRUCache } from '../../utils/compat';
import { drawRect, drawSingleLineText } from '../base-renderer';
import type {
  ICellClickCallback,
  ICellClickProps,
  ICellRenderProps,
  IInternalCellRenderer,
  IStageAttachmentBadge,
  IStageCell,
} from './interface';
import { CellRegionType, CellType } from './interface';

const { cellHorizontalPadding } = GRID_DEFAULT;

const STAGE_PALETTE: Record<
  IStageCell['data']['status'],
  {
    bg: string;
    bgHover: string;
    accent: string | null;
    dot: string | null;
    text: string;
    mutedText: string;
  }
> = {
  not_started: {
    bg: '#FFFFFF',
    bgHover: '#FAFAFA',
    accent: null,
    dot: '#D4D4D8',
    text: '#18181B',
    mutedText: '#A1A1AA',
  },
  in_progress: {
    bg: '#FEFCE8',
    bgHover: '#FEF9C3',
    accent: null,
    dot: '#EAB308',
    text: '#854D0E',
    mutedText: '#CA8A04',
  },
  done: {
    bg: '#ECFDF5',
    bgHover: '#DCFCE7',
    accent: null,
    dot: '#10B981',
    text: '#065F46',
    mutedText: '#059669',
  },
  na: {
    bg: '#F4F4F5',
    bgHover: '#ECECEE',
    accent: null,
    dot: null,
    text: '#A1A1AA',
    mutedText: '#A1A1AA',
  },
};

const STAGE_MISSING_PALETTE = {
  bg: '#FEF2F2',
  bgHover: '#FEE2E2',
  accent: null,
  dot: '#EF4444',
  text: '#991B1B',
  mutedText: '#DC2626',
};

// Cache attachment hotspot bounds relative to cell top-left so click hit-testing stays O(1)
const attachmentHotspotCache = new LRUCache<string, IRectangle>({ max: 500 });

function getAttachmentCacheKey(cell: IStageCell, width: number, height: number): string {
  const att = cell.data.attachment;
  return `${cell.id ?? ''}:${att?.kind ?? ''}:${att?.label ?? ''}:${width}:${height}`;
}

function drawCheckIcon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + 1.5, y + 6.5);
  ctx.lineTo(x + 4.5, y + 9.5);
  ctx.lineTo(x + 10.5, y + 3);
  ctx.stroke();
  ctx.restore();
}

function drawNoteMicroIcon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.roundRect(x, y, 11, 9, 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 2.5, y + 3.5);
  ctx.lineTo(x + 8.5, y + 3.5);
  ctx.moveTo(x + 2.5, y + 6);
  ctx.lineTo(x + 6.5, y + 6);
  ctx.stroke();
  ctx.restore();
}

export const stageCellRenderer: IInternalCellRenderer<IStageCell> = {
  type: CellType.Stage,
  needsHover: true,
  needsHoverPosition: (cell: IStageCell) => Boolean(cell.data.attachment),
  needsHoverWhenActive: true,
  needsHoverPositionWhenActive: true,
  draw: (cell: IStageCell, props: ICellRenderProps) => {
    const { ctx, rect, theme, hoverCellPosition } = props;
    const { x, y, width, height } = rect;
    const { status, assigneesText, note, attachment } = cell.data;
    const isMissing = status === 'not_started' && !assigneesText;
    const palette = isMissing ? STAGE_MISSING_PALETTE : STAGE_PALETTE[status];
    const isHovered = hoverCellPosition != null;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    // 1. Soft full-cell status fill
    drawRect(ctx, {
      x: x + 0.5,
      y: y + 0.5,
      width: Math.max(0, width - 1),
      height: Math.max(0, height - 1),
      fill: isHovered ? palette.bgHover : palette.bg,
    });

    // 2. Crisp 2px left accent bar for active / completed stages
    if (palette.accent) {
      drawRect(ctx, {
        x: x + 0.5,
        y: y + 0.5,
        width: 2,
        height: Math.max(0, height - 1),
        fill: palette.accent,
      });
    }

    // 3. Reserve right-side slots (attachment badge + note micro-icon)
    let rightReserved = cellHorizontalPadding;

    if (attachment) {
      const badgePrefix = attachment.kind === 'r2' ? '⬇ ' : '🔗 ';
      const badgeLabel = `${badgePrefix}${attachment.label}`;
      ctx.font = `500 10px ${theme.fontFamily}`;
      const textW = Math.min(ctx.measureText(badgeLabel).width, 64);
      const badgeW = textW + 10;
      const badgeH = 18;
      const badgeRelX = Math.max(cellHorizontalPadding, width - rightReserved - badgeW);
      const badgeRelY = (height - badgeH) / 2;

      const cacheKey = getAttachmentCacheKey(cell, width, height);
      attachmentHotspotCache.set(cacheKey, {
        x: badgeRelX,
        y: badgeRelY,
        width: badgeW,
        height: badgeH,
      });

      const badgeHovered =
        hoverCellPosition != null &&
        inRange(hoverCellPosition[0], badgeRelX, badgeRelX + badgeW) &&
        inRange(hoverCellPosition[1], badgeRelY, badgeRelY + badgeH);

      drawRect(ctx, {
        x: x + badgeRelX,
        y: y + badgeRelY,
        width: badgeW,
        height: badgeH,
        radius: 4,
        fill: badgeHovered ? '#FFFFFF' : 'rgba(255, 255, 255, 0.88)',
        stroke: badgeHovered ? '#3B82F6' : 'rgba(0, 0, 0, 0.1)',
      });

      drawSingleLineText(ctx, {
        x: x + badgeRelX + 5,
        y: y + badgeRelY + 4,
        text: badgeLabel,
        fill: badgeHovered ? '#1D4ED8' : '#3F3F46',
        fontSize: 10,
        maxWidth: textW + 2,
      });

      rightReserved += badgeW + 6;
    }

    if (note) {
      const iconW = 11;
      const iconX = x + width - rightReserved - iconW;
      const iconY = y + (height - 9) / 2;
      drawNoteMicroIcon(ctx, iconX, iconY, '#A1A1AA');
      rightReserved += iconW + 6;
    }

    // 4. Left status indicator + assignee text
    let leftX = x + cellHorizontalPadding + (palette.accent ? 2 : 0);
    const centerY = y + height / 2;

    if (status === 'done') {
      drawCheckIcon(ctx, leftX, centerY - 6, '#059669');
      leftX += 16;
    } else if (palette.dot) {
      ctx.beginPath();
      ctx.arc(leftX + 3, centerY, 3, 0, Math.PI * 2);
      ctx.fillStyle = palette.dot;
      ctx.fill();
      leftX += 11;
    }

    const availableTextW = Math.max(0, x + width - rightReserved - leftX);
    const isMedium = status === 'in_progress' || status === 'done';
    ctx.font = `${isMedium ? '500' : '400'} ${theme.fontSizeSM}px ${theme.fontFamily}`;

    let label = '';
    let labelColor = palette.text;

    if (status === 'na') {
      label = '—';
      labelColor = palette.mutedText;
    } else if (assigneesText) {
      label = assigneesText;
      labelColor = palette.text;
    } else if (status === 'not_started') {
      label = '待认领';
      labelColor = palette.mutedText;
    } else if (status === 'in_progress') {
      label = '进行中';
      labelColor = palette.text;
    } else {
      label = '已完成';
      labelColor = palette.text;
    }

    if (availableTextW > 4) {
      drawSingleLineText(ctx, {
        x: leftX,
        y: centerY - theme.fontSizeSM / 2,
        text: label,
        fill: labelColor,
        fontSize: theme.fontSizeSM,
        maxWidth: availableTextW,
      });
    }

    ctx.restore();
  },
  checkRegion: (cell: IStageCell, props: ICellClickProps) => {
    const att = cell.data.attachment;
    if (!att) return { type: CellRegionType.Blank };
    const { hoverCellPosition, width, height } = props;
    const [hx, hy] = hoverCellPosition;
    const rect = attachmentHotspotCache.get(getAttachmentCacheKey(cell, width, height));
    if (rect && inRange(hx, rect.x, rect.x + rect.width) && inRange(hy, rect.y, rect.y + rect.height)) {
      return {
        type: CellRegionType.Preview,
        data: att as IStageAttachmentBadge,
      };
    }
    return { type: CellRegionType.Blank };
  },
  onClick: (cell: IStageCell, props: ICellClickProps, callback: ICellClickCallback) => {
    const region = stageCellRenderer.checkRegion?.(cell, props, true);
    if (!region || region.type === CellRegionType.Blank) return;
    if (region.type === CellRegionType.Preview && cell.data.attachment) {
      cell.onAttachmentClick?.(cell.data.attachment);
      callback(region);
    }
  },
};
