import type { Priority, StageStatus, WorksheetColor } from '@nw/shared';

export const WORKSHEET_COLOR_STYLES: Record<
  WorksheetColor,
  { dot: string; badge: string; border: string }
> = {
  slate: {
    dot: 'bg-slate-500',
    badge: 'bg-slate-100 text-slate-700 border-slate-200',
    border: 'border-slate-300',
  },
  red: {
    dot: 'bg-red-500',
    badge: 'bg-red-50 text-red-700 border-red-200',
    border: 'border-red-300',
  },
  orange: {
    dot: 'bg-orange-500',
    badge: 'bg-orange-50 text-orange-700 border-orange-200',
    border: 'border-orange-300',
  },
  amber: {
    dot: 'bg-amber-500',
    badge: 'bg-amber-50 text-amber-800 border-amber-200',
    border: 'border-amber-300',
  },
  emerald: {
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    border: 'border-emerald-300',
  },
  teal: {
    dot: 'bg-teal-500',
    badge: 'bg-teal-50 text-teal-700 border-teal-200',
    border: 'border-teal-300',
  },
  sky: {
    dot: 'bg-sky-500',
    badge: 'bg-sky-50 text-sky-700 border-sky-200',
    border: 'border-sky-300',
  },
  blue: {
    dot: 'bg-blue-500',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    border: 'border-blue-300',
  },
  indigo: {
    dot: 'bg-indigo-500',
    badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    border: 'border-indigo-300',
  },
  violet: {
    dot: 'bg-violet-500',
    badge: 'bg-violet-50 text-violet-700 border-violet-200',
    border: 'border-violet-300',
  },
  pink: {
    dot: 'bg-pink-500',
    badge: 'bg-pink-50 text-pink-700 border-pink-200',
    border: 'border-pink-300',
  },
  rose: {
    dot: 'bg-rose-500',
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    border: 'border-rose-300',
  },
};

export const STAGE_STATUS_STYLES: Record<
  StageStatus,
  { cell: string; dot: string; badge: string }
> = {
  not_started: {
    cell: 'bg-slate-50 text-slate-600 border-slate-200',
    dot: 'bg-slate-300',
    badge: 'bg-slate-100 text-slate-700',
  },
  in_progress: {
    cell: 'bg-sky-50 text-sky-800 border-sky-200',
    dot: 'bg-sky-500',
    badge: 'bg-sky-100 text-sky-800',
  },
  done: {
    cell: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-800',
  },
  na: {
    cell: 'bg-slate-100/60 text-slate-400 border-slate-200/60',
    dot: 'bg-slate-200',
    badge: 'bg-slate-100 text-slate-400',
  },
};

export const PRIORITY_STYLES: Record<Priority, string> = {
  normal: 'bg-slate-100 text-slate-600 border-slate-200/80',
  high: 'bg-amber-50 text-amber-800 border-amber-200/90',
  urgent: 'bg-red-50 text-red-700 border-red-200/90',
};

export const PRIORITY_DOT_STYLES: Record<Priority, string> = {
  normal: 'bg-slate-400',
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
