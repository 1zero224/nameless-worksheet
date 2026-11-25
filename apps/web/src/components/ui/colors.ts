import type { Priority, StageStatus, WorksheetColor } from '@nw/shared';

export const WORKSHEET_COLOR_STYLES: Record<
  WorksheetColor,
  { dot: string; badge: string; border: string; hex: string }
> = {
  slate: {
    dot: 'bg-zinc-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-zinc-300',
    hex: '#71717a',
  },
  red: {
    dot: 'bg-red-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-red-300',
    hex: '#ef4444',
  },
  orange: {
    dot: 'bg-orange-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-orange-300',
    hex: '#f97316',
  },
  amber: {
    dot: 'bg-amber-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-amber-300',
    hex: '#f59e0b',
  },
  emerald: {
    dot: 'bg-emerald-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-emerald-300',
    hex: '#10b981',
  },
  teal: {
    dot: 'bg-teal-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-teal-300',
    hex: '#14b8a6',
  },
  sky: {
    dot: 'bg-sky-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-sky-300',
    hex: '#0ea5e9',
  },
  blue: {
    dot: 'bg-blue-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-blue-300',
    hex: '#3b82f6',
  },
  indigo: {
    dot: 'bg-indigo-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-indigo-300',
    hex: '#6366f1',
  },
  violet: {
    dot: 'bg-violet-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-violet-300',
    hex: '#8b5cf6',
  },
  pink: {
    dot: 'bg-pink-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-pink-300',
    hex: '#ec4899',
  },
  rose: {
    dot: 'bg-rose-500',
    badge: 'bg-white text-zinc-700 border-black/[0.08]',
    border: 'border-rose-300',
    hex: '#f43f5e',
  },
};

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
    cell: 'bg-[#EFF6FF] text-[#1E40AF] border-blue-200/70',
    fill: 'bg-[#EFF6FF] hover:bg-[#DBEAFE]/70',
    accent: 'bg-[#3B82F6]',
    dot: 'bg-[#3B82F6]',
    badge: 'bg-[#EFF6FF] text-[#1D4ED8]',
    text: 'text-[#1E3A8A] font-medium',
  },
  done: {
    cell: 'bg-[#ECFDF5] text-[#065F46] border-emerald-200/70',
    fill: 'bg-[#ECFDF5] hover:bg-[#D1FAE5]/70',
    accent: 'bg-[#10B981]',
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
    bg: '#EFF6FF',
    bgHover: '#E0EEFF',
    accent: '#3B82F6',
    dot: '#3B82F6',
    text: '#1E3A8A',
    mutedText: '#3B82F6',
  },
  done: {
    bg: '#ECFDF5',
    bgHover: '#DCFCE7',
    accent: '#10B981',
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
  normal: 'bg-zinc-100/80 text-zinc-600 border-black/[0.06]',
  high: 'bg-amber-50/90 text-amber-800 border-amber-200/80',
  urgent: 'bg-red-50/90 text-red-700 border-red-200/80',
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
