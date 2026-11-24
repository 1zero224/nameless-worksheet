import { Card } from '@/components/ui/primitives.js';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <Card>
        <p className="text-sm text-slate-500">此功能将在后续阶段提供</p>
      </Card>
    </div>
  );
}
