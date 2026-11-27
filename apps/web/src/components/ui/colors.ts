import type { Priority, StageStatus } from '@nw/shared';

export const STAGE_STATUS_STYLES: Record<
  StageStatus,
  { cell: string; fill: string; accent: string; dot: string; badge: string; text: string }
> = {
  not_started: {
    cell: 'bg-zinc-50 text-zinc-600 border-black/[0.08]',
    fill: 'bg-white hover:bg-black/[0.02]',
    accent: '',
    dot: 'bg-zinc-300',
    badge: 'bg-zinc-100/90 text-zinc-600',
    text: 'text-zinc-700',
  },
  in_progress: {
    cell: 'bg-[#FEFCE8] text-[#854D0E] border-amber-200/90',
    fill: 'bg-[#FEFCE8] hover:bg-[#FEF9C3]/80',
    accent: '',
    dot: 'bg-[#EAB308]',
    badge: 'bg-[#FEF9C3] text-[#854D0E]',
    text: 'text-[#854D0E] font-medium',
  },
  done: {
    cell: 'bg-[#ECFDF5] text-[#065F46] border-emerald-200/70',
    fill: 'bg-[#ECFDF5] hover:bg-[#D1FAE5]/70',
    accent: '',
    dot: 'bg-[#10B981]',
    badge: 'bg-[#ECFDF5] text-[#047857]',
    text: 'text-[#065F46] font-medium',
  },
  na: {
    cell: 'bg-[#F4F4F5] text-zinc-400 border-black/[0.06]',
    fill: 'bg-[#F4F4F5] hover:bg-[#E4E4E7]/60',
    accent: '',
    dot: 'bg-zinc-300',
    badge: 'bg-zinc-100 text-zinc-400',
    text: 'text-zinc-400',
  },
};

export const STAGE_MISSING_STYLE = {
  cell: 'bg-[#FEF2F2] text-[#991B1B] border-red-200/85',
  fill: 'bg-[#FEF2F2] hover:bg-[#FEE2E2]/80',
  accent: '',
  dot: 'bg-[#EF4444]',
  badge: 'bg-[#FEE2E2] text-[#991B1B]',
  text: 'text-[#991B1B] font-medium',
} as const;

export type BoardCardVisualState = 'in_progress' | 'missing' | 'waiting';

export const BOARD_CARD_STATE_STYLES: Record<
  BoardCardVisualState,
  {
    card: string;
    subCard: string;
    title: string;
    statusText: string;
    dot: string;
    actionBtn: string;
    meTag: string;
  }
> = {
  in_progress: {
    card: 'border-black/[0.08] border-l-2 border-l-amber-400 bg-[#FEFCE8]/70 hover:border-black/[0.14] hover:border-l-amber-500 hover:bg-[#FEFCE8]',
    subCard:
      'border-black/[0.07] border-l-2 border-l-amber-400 bg-[#FEFCE8]/65 hover:border-black/[0.13] hover:border-l-amber-500 hover:bg-[#FEFCE8]',
    title: 'text-zinc-900 group-hover:text-amber-950',
    statusText: 'text-amber-900/90 font-medium',
    dot: 'bg-amber-500/85',
    actionBtn: 'text-amber-900/85 hover:bg-amber-950/[0.08] hover:text-amber-950',
    meTag: 'text-amber-800/90',
  },
  missing: {
    card: 'border-black/[0.08] border-l-2 border-l-red-400 bg-[#FEF2F2]/70 hover:border-black/[0.14] hover:border-l-red-500 hover:bg-[#FEF2F2]',
    subCard:
      'border-black/[0.07] border-l-2 border-l-red-400 bg-[#FEF2F2]/65 hover:border-black/[0.13] hover:border-l-red-500 hover:bg-[#FEF2F2]',
    title: 'text-zinc-900 group-hover:text-red-950',
    statusText: 'text-red-900/85 font-medium',
    dot: 'bg-red-500/80',
    actionBtn: 'text-red-800/90 hover:bg-red-950/[0.08] hover:text-red-950',
    meTag: 'text-red-800/90',
  },
  waiting: {
    card: 'border-black/[0.09] border-l-2 border-l-zinc-300 bg-white hover:border-black/[0.16] hover:bg-[#fafafa]',
    subCard:
      'border-black/[0.08] border-l-2 border-l-zinc-300 bg-[#fafafa]/70 hover:border-black/[0.14] hover:bg-zinc-100/65',
    title: 'text-zinc-900 group-hover:text-zinc-950',
    statusText: 'text-zinc-600',
    dot: 'bg-zinc-300',
    actionBtn: 'text-zinc-600 hover:bg-black/[0.06] hover:text-zinc-950',
    meTag: 'text-zinc-600',
  },
};

export const STAGE_STATUS_CANVAS_COLORS: Record<
  StageStatus,
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

export const PRIORITY_STYLES: Record<Priority, string> = {
  normal: 'text-zinc-500',
  high: 'text-amber-700 font-semibold',
  urgent: 'text-red-600 font-semibold',
};

export const PRIORITY_DOT_STYLES: Record<Priority, string> = {
  normal: 'bg-zinc-400',
  high: 'bg-amber-500',
  urgent: 'bg-red-500',
};

const PEER_PALETTE = [
  { hex: '#2563eb', bg: 'bg-blue-600', ring: 'ring-blue-600', text: 'text-white' },
  { hex: '#059669', bg: 'bg-emerald-600', ring: 'ring-emerald-600', text: 'text-white' },
  { hex: '#d97706', bg: 'bg-amber-600', ring: 'ring-amber-600', text: 'text-white' },
  { hex: '#dc2626', bg: 'bg-red-600', ring: 'ring-red-600', text: 'text-white' },
  { hex: '#7c3aed', bg: 'bg-violet-600', ring: 'ring-violet-600', text: 'text-white' },
  { hex: '#db2777', bg: 'bg-pink-600', ring: 'ring-pink-600', text: 'text-white' },
  { hex: '#0891b2', bg: 'bg-cyan-600', ring: 'ring-cyan-600', text: 'text-white' },
  { hex: '#ea580c', bg: 'bg-orange-600', ring: 'ring-orange-600', text: 'text-white' },
] as const;

export function peerColorForUser(userId: string) {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = (hash >>> 0) % PEER_PALETTE.length;
  return PEER_PALETTE[idx]!;
}
