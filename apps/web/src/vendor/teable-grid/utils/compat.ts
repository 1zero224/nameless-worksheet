import { type DependencyList, type EffectCallback, type RefObject, useEffect, useRef, useState } from 'react';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function getRandomString(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function contractColorForTheme(color: string, _themeKey?: string): string {
  return color;
}

export enum Colors {
  Gray = 'gray',
  Blue = 'blue',
  Green = 'green',
  Red = 'red',
  Yellow = 'yellow',
  Orange = 'orange',
  Purple = 'purple',
}

export function getSelectColorPairs(
  _color: string,
  _themeKey?: string,
): { color: string; backgroundColor: string } {
  return { color: '#18181b', backgroundColor: '#f4f4f5' };
}

export interface IUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string | null;
  phone?: string;
}

export interface IButtonFieldCellValue {
  count?: number;
}

export interface IButtonFieldOptions {
  label: string;
  color: string;
  confirm?: unknown;
}

export interface IButtonClickStatusHook {
  checkLoading?: (fieldId: string, recordId: string) => boolean;
  buttonClick: (params: Record<string, unknown>) => void;
}

export interface IRecord {
  id: string;
  fields?: Record<string, unknown>;
}

export interface IUrlMatch {
  start: number;
  end: number;
  url: string;
}

export class LRUCache<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(options?: { max?: number; maxSize?: number; sizeCalculation?: (v: V, k: K) => number }) {
    this.max = options?.max ?? 500;
  }

  get(key: K): V | undefined {
    const val = this.map.get(key);
    if (val === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export function isContentDirectionEnabled(): boolean {
  return false;
}

export function detectTextDirection(_text: string): 'ltr' | 'rtl' | null {
  return null;
}

export function resolveContentDirection(_text: string): 'ltr' | 'rtl' | null {
  return null;
}

export function useUiDirection(): 'ltr' | 'rtl' {
  return 'ltr';
}

export function useContentDir(): 'ltr' | 'rtl' | 'auto' {
  return 'ltr';
}

export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(pointer: coarse)').matches ?? false;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = (e: MediaQueryListEvent) => setIsTouch(e.matches);
    setIsTouch(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return isTouch;
}

export function useUpdateEffect(effect: EffectCallback, deps?: DependencyList): void {
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    return effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useMouse(ref: RefObject<Element | null>): { elX: number; elY: number } {
  const [pos, setPos] = useState({ elX: 0, elY: 0 });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({
        elX: e.clientX - rect.left,
        elY: e.clientY - rect.top,
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [ref]);

  return pos;
}

export const Key = {
  Shift: 'Shift',
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
} as const;

export const KeyCode = {
  Enter: 13,
  Space: 32,
  ClosedParen: 48,
  OpenParen: 57,
  A: 65,
  Z: 90,
  Numpad0: 96,
  Numpad9: 105,
  Multiply: 106,
  Divide: 111,
  SemiColon: 186,
  Tilde: 192,
  OpenBracket: 219,
  Quote: 222,
} as const;
