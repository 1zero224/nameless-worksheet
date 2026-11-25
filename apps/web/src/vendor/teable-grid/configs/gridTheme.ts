import { hexToRGBA } from '../utils';

export interface IGridTheme {
  staticWhite: string;
  staticBlack: string;
  iconBgCommon: string;
  iconFgCommon: string;
  iconFgHighlight: string;
  iconBgHighlight: string;
  iconBgSelected: string;
  iconFgSelected: string;
  iconSizeXS: number;
  iconSizeSM: number;
  iconSizeMD: number;
  iconSizeLG: number;
  fontSizeXXS: number;
  fontSizeXS: number;
  fontSizeSM: number;
  fontSizeMD: number;
  fontSizeLG: number;
  fontFamily: string;
  cellBg: string;
  cellBgHovered: string;
  cellBgSelected: string;
  cellBgLoading: string;
  cellLineColor: string;
  cellLineColorActived: string;
  cellTextColor: string;
  cellTextColorHighlight: string;
  cellOptionBg: string;
  cellOptionBgHighlight: string;
  cellOptionTextColor: string;
  groupHeaderBgPrimary: string;
  groupHeaderBgSecondary: string;
  groupHeaderBgTertiary: string;
  columnHeaderBg: string;
  columnHeaderBgHovered: string;
  columnHeaderBgSelected: string;
  columnHeaderNameColor: string;
  columnResizeHandlerBg: string;
  columnDraggingPlaceholderBg: string;
  columnStatisticBgHoveredPrimary: string;
  columnStatisticBgHoveredSecondary: string;
  columnStatisticBgHoveredTertiary: string;
  rowHeaderTextColor: string;
  appendRowBg: string;
  appendRowBgHovered: string;
  avatarBg: string;
  avatarTextColor: string;
  avatarSizeXS: number;
  avatarSizeSM: number;
  avatarSizeMD: number;
  themeKey: string;
  scrollBarBg: string;
  interactionLineColorCommon: string;
  interactionLineColorHighlight: string;
  searchCursorBg: string;
  searchTargetIndexBg: string;
  searchTargetIndexSelectedBg: string;
  commentCountBg: string;
  commentCountTextColor: string;
}

export const gridTheme: IGridTheme = {
  // Common
  staticWhite: '#FFFFFF',
  staticBlack: '#000000',
  iconFgCommon: '#71717A',
  iconBgCommon: 'transparent',
  iconFgHighlight: '#FACC15',
  iconBgHighlight: '#FACC15',
  iconFgSelected: '#EFF6FF',
  iconBgSelected: '#18181B',
  iconSizeXS: 16,
  iconSizeSM: 20,
  iconSizeMD: 24,
  iconSizeLG: 32,
  fontSizeXXS: 10,
  fontSizeXS: 12,
  fontSizeSM: 13,
  fontSizeMD: 14,
  fontSizeLG: 16,
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif',

  // Cell (Teable neutral zinc palette with subtle 8% black hairline borders)
  cellBg: '#FFFFFF',
  cellBgHovered: '#FAFAFA',
  cellBgSelected: '#F4F4F5',
  cellBgLoading: hexToRGBA('#000000', 0.04),
  cellLineColor: 'rgba(0, 0, 0, 0.08)',
  cellLineColorActived: '#2563EB',
  cellTextColor: '#09090B',
  cellTextColorHighlight: '#2563EB',
  cellOptionBg: '#E4E4E7',
  cellOptionBgHighlight: '#D4D4D8',
  cellOptionTextColor: '#09090B',

  // Group Header
  groupHeaderBgPrimary: '#FAFAFA',
  groupHeaderBgSecondary: '#F4F4F5',
  groupHeaderBgTertiary: '#E4E4E7',

  // Column Statistic
  columnStatisticBgHoveredPrimary: '#F4F4F5',
  columnStatisticBgHoveredSecondary: '#EBEBED',
  columnStatisticBgHoveredTertiary: '#E4E4E7',

  // Column Header
  columnHeaderBg: '#FAFAFA',
  columnHeaderBgHovered: '#F4F4F5',
  columnHeaderBgSelected: '#E4E4E7',
  columnHeaderNameColor: '#52525B',
  columnResizeHandlerBg: '#2563EB',
  columnDraggingPlaceholderBg: hexToRGBA('#000000', 0.16),

  // Row Header
  rowHeaderTextColor: '#A1A1AA',

  // Append Row
  appendRowBg: '#FAFAFA',
  appendRowBgHovered: '#F4F4F5',

  // Avatar Theme
  avatarBg: '#F4F4F5',
  avatarTextColor: '#09090B',
  avatarSizeXS: 16,
  avatarSizeSM: 20,
  avatarSizeMD: 24,

  themeKey: 'light',

  // ScrollBar
  scrollBarBg: '#A1A1AA',

  // interaction
  interactionLineColorCommon: '#D4D4D8',
  interactionLineColorHighlight: '#2563EB',

  // search cursor
  searchCursorBg: '#93C5FD',
  searchTargetIndexBg: '#DBEAFE',
  searchTargetIndexSelectedBg: '#BFDBFE',

  // comment
  commentCountBg: '#FB923C',
  commentCountTextColor: '#FFFFFF',
};
