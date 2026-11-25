import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  GripVertical,
  Info,
  Lock,
  Maximize2,
  Plus,
  X,
} from 'lucide-react';
import { renderToString } from 'react-dom/server';

export interface ISpriteProps {
  fgColor: string;
  bgColor: string;
}

const drag = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<GripVertical color={fgColor} strokeWidth={1.75} />);
};

const detail = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<Maximize2 color={fgColor} strokeWidth={1.75} />);
};

const add = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<Plus color={fgColor} strokeWidth={1.75} />);
};

const description = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<Info color={fgColor} strokeWidth={1.75} />);
};

const close = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<X color={fgColor} strokeWidth={1.75} />);
};

const expand = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<ChevronDown color={fgColor} strokeWidth={1.75} />);
};

const collapse = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<ChevronRight color={fgColor} strokeWidth={1.75} />);
};

const lock = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<Lock color={fgColor} strokeWidth={1.75} />);
};

export const eyeOff = (props: ISpriteProps) => {
  const { fgColor } = props;
  return renderToString(<EyeOff color={fgColor} strokeWidth={1.75} />);
};

export const sprites = {
  add,
  drag,
  detail,
  description,
  close,
  expand,
  collapse,
  lock,
  eyeOff,
};

export enum GridInnerIcon {
  Add = 'add',
  Drag = 'drag',
  Detail = 'detail',
  Description = 'description',
  Close = 'close',
  Expand = 'expand',
  Collapse = 'collapse',
  Lock = 'lock',
  EyeOff = 'eyeOff',
}
