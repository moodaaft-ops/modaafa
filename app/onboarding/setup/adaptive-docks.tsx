'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { CONFIRM_OPTIONS } from '@/lib/setup/adaptive/answers';
import type { AdaptiveQuestion, BusinessKind, DominantOutcome } from '@/lib/setup/adaptive/types';
import { AnswerTile, BackLink, TextAnswer, iconFor, inputClass, type AnswerPayload, type TileIcon } from './docks';
import {
  EXCLUSIVE_OPTION_ID,
  chipsPayload,
  confirmPayload,
  freeTextPayload,
  optionPayload,
  toggleId,
} from './adaptive-flow';

/**
 * The docks of the adaptive tree: the opener's «صح كذا؟», and every question
 * the bank wrote its own copy for. A question the bank has no copy for keeps
 * the legacy dock (docks.tsx), so nothing here asks for a key it does not know.
 */

export function ConfirmDock({
  proposal,
  busy,
  onAnswer,
}: {
  proposal: { kind: BusinessKind; outcome: DominantOutcome } | null;
  busy: boolean;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {CONFIRM_OPTIONS.map((option) => (
        <AnswerTile
          key={option.id}
          label={option.label}
          icon={option.id === 'yes' ? 'check' : 'pencil'}
          compact
          disabled={busy}
          onClick={() => onAnswer(confirmPayload(option, proposal))}
        />
      ))}
    </div>
  );
}

export function AdaptiveDock({
  question,
  busy,
  canBack,
  onBack,
  onAnswer,
}: {
  question: AdaptiveQuestion;
  busy: boolean;
  canBack: boolean;
  onBack: () => void;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  return (
    <div>
      {question.layout === 'chips' ? (
        <ChipsDock question={question} busy={busy} onAnswer={onAnswer} />
      ) : (
        <TilesDock question={question} busy={busy} onAnswer={onAnswer} />
      )}
      {canBack && <BackLink onBack={onBack} />}
    </div>
  );
}

/**
 * Icons the approved snapshots show on options the bank gives none to: a clock on every answering-hours choice, and a
 * check or an arrow on «قريب من الصح؟». An icon the bank does send always wins.
 */
const FALLBACK_ICON: Record<string, TileIcon> = {
  'aov_check:same': 'check',
  'aov_check:less': 'arrow-down',
  'aov_check:more': 'arrow-up',
};

function fallbackIcon(key: string, optionId: string): TileIcon | undefined {
  if (key === 'call_hours') return 'clock';
  return FALLBACK_ICON[`${key}:${optionId}`];
}

function TilesDock({
  question,
  busy,
  onAnswer,
}: {
  question: AdaptiveQuestion;
  busy: boolean;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const { freeText, current } = question;
  // With a field to type in, «غير كذا» is the field itself, not a tile that would send nothing.
  const options = freeText ? question.options.filter((option) => option.id !== 'other') : question.options;
  const columns = question.layout === 'tiles2' ? 2 : 1;
  return (
    <div className="space-y-2">
      {options.length > 0 && (
        <div className={cn('grid gap-2', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
          {options.map((option) => (
            <AnswerTile
              key={option.id}
              label={option.label}
              hint={option.hint}
              icon={iconFor(option.icon) ?? fallbackIcon(question.key, option.id)}
              compact={columns === 2}
              current={current === option.id}
              disabled={busy}
              onClick={() => onAnswer(optionPayload(option))}
            />
          ))}
        </div>
      )}
      {freeText && (
        <TextAnswer
          placeholder={freeText.placeholder}
          maxLength={freeText.maxLength}
          busy={busy}
          onSubmit={(text) => onAnswer(freeTextPayload(question.key, text))}
        />
      )}
    </div>
  );
}

function ChipsDock({
  question,
  busy,
  onAnswer,
}: {
  question: AdaptiveQuestion;
  busy: boolean;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const exclusive = question.options.find((option) => option.id === EXCLUSIVE_OPTION_ID) ?? null;
  const chips = question.options.filter((option) => option.id !== EXCLUSIVE_OPTION_ID);
  const [selected, setSelected] = useState<string[]>(() =>
    question.current && chips.some((chip) => chip.id === question.current) ? [question.current] : []
  );
  const [text, setText] = useState('');
  const typed = text.trim();
  const ready = selected.length > 0 || typed.length >= 2;
  const picked = chips.filter((chip) => selected.includes(chip.id));
  const { freeText } = question;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onAnswer(chipsPayload(picked, typed.length >= 2 ? typed : ''));
      }}
    >
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={question.text}>
          {chips.map((chip) => {
            const on = selected.includes(chip.id);
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={on}
                disabled={busy}
                onClick={() => setSelected((list) => toggleId(list, chip.id))}
                className={cn(
                  'min-h-[44px] max-w-full break-words rounded-full border px-4 py-2 text-start text-[14.5px] font-semibold leading-6 transition-colors disabled:opacity-50',
                  on ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-foreground hover:bg-muted'
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
      )}
      {freeText && (
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={freeText.placeholder}
          maxLength={freeText.maxLength}
          aria-label={freeText.placeholder}
          className={inputClass}
        />
      )}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !ready}
          className="h-14 min-w-0 flex-1 rounded-full bg-primary px-6 text-[16px] font-bold text-primary-foreground disabled:opacity-40"
        >
          تم
        </button>
        {exclusive && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onAnswer({ answer: { choice: exclusive.id, choices: [exclusive.id] }, label: exclusive.label })
            }
            className="min-h-12 flex-shrink-0 rounded-full px-3 text-[14.5px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {exclusive.label}
          </button>
        )}
      </div>
    </form>
  );
}
