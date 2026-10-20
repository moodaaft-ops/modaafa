import { launchPreviewModel } from './preview';
import type { LaunchPlan } from './types';

/** Compact, mobile first: one column, short rows, nothing wider than the screen. */
export function LaunchPlanPreview({ plan }: { plan: LaunchPlan | null | undefined }) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.ad_groups)) return null;
  const model = launchPreviewModel(plan);
  return (
    <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/50 p-3 text-xs" data-testid="launch-plan-preview">
      <div className="text-sm font-semibold text-foreground">{model.title}</div>
      <dl className="space-y-1 text-muted-foreground">
        {model.facts.map((fact) => (
          <div key={fact.label} className="flex flex-wrap gap-x-2">
            <dt className="font-medium">{fact.label}:</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2">
        {model.groups.map((group) => (
          <details key={group.name} className="rounded border border-border bg-background p-2">
            <summary className="cursor-pointer font-medium text-foreground">
              {group.name} <span className="font-normal text-muted-foreground">({group.summary})</span>
            </summary>
            {group.keywords.length > 0 && (
              <p className="mt-2 break-words text-muted-foreground" dir="auto">
                {group.keywords.join('  ')}
              </p>
            )}
            {group.headlines.length > 0 && (
              <p className="mt-2 leading-5 text-foreground">
                {group.headlines.join(' | ')}
                {group.description ? <span className="block text-muted-foreground">{group.description}</span> : null}
              </p>
            )}
          </details>
        ))}
      </div>
      <ul className="list-disc space-y-1 pr-4 text-muted-foreground">
        {model.off.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {model.notes.length > 0 && (
        <ul className="list-disc space-y-1 pr-4 text-amber-700">
          {model.notes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
