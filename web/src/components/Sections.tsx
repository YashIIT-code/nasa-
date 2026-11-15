import { lazy, Suspense, useRef } from 'react';
import { baselineFails } from '../lib/answer.ts';
import { useApp } from '../lib/AppState.tsx';
import { C, fill } from '../lib/content.ts';
import { ready, useData } from '../lib/DataContext.tsx';
import { fmtNumber, fmtPercent } from '../lib/format.ts';
import { priorityCommunities, priorityRoads, type PriorityItem } from '../lib/priority.ts';
import type { ValidationStats } from '../lib/types.ts';
import { useNearViewport } from '../lib/useNearViewport.ts';
import { FileError } from './FileError.tsx';
import { REPO } from './Header.tsx';
import { Skeleton } from './Skeleton.tsx';

// the charting library is large: fetched only when this section is on the page
const DetectionBySize = lazy(() => import('./charts/DetectionBySize.tsx').then((m) => ({ default: m.DetectionBySize })));

const section = 'mx-auto max-w-3xl xl:ml-14 xl:mr-0 scroll-mt-16 px-4 py-10';
const prose = 'space-y-3 text-[17px] leading-relaxed';
const ext = 'underline decoration-brand decoration-2 underline-offset-2';

/** "19 of 57 (33%)" */
function countOf(rate: number, n: number): string {
  return `${fill(C.sure.of, { k: Math.round(rate * n), n })} (${fmtPercent(rate, 0)}%)`;
}

function ScoreTable({ v, original }: { v: ValidationStats; original: ValidationStats | null }) {
  const cols = [...(original ? [{ head: C.sure.original, s: original }] : []), { head: C.sure.revised, s: v }];
  const rows: { label: string; value: (s: ValidationStats) => string }[] = [
    { label: C.sure.detection, value: (s) => countOf(s.detection_rate, s.n_test_landslide) },
    { label: C.sure.falseAlarm, value: (s) => countOf(s.false_alarm_rate, s.n_test_forest) },
    { label: C.sure.precision, value: (s) => (s.precision === null ? '–' : fmtNumber(s.precision, 2)) },
    { label: C.sure.f1, value: (s) => (s.f1 === null ? '–' : fmtNumber(s.f1, 2)) },
    { label: C.sure.auc, value: (s) => fmtNumber(s.auc, 2) },
    { label: C.sure.threshold, value: (s) => `${fmtNumber(s.threshold_db, 1)} dB` },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[15px]">
        <caption className="mb-2 text-left font-semibold">{C.sure.tableCaption}</caption>
        <thead>
          <tr className="border-b border-ink/30 text-left">
            <td />
            {cols.map((c) => <th key={c.head} scope="col" className="py-1 pr-3 font-semibold">{c.head}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-ink/10">
              <th scope="row" className="py-1.5 pr-3 text-left font-normal">{r.label}</th>
              {cols.map((c) => <td key={c.head} className="num py-1.5 pr-3">{r.value(c.s)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The chart (and the charting library) is fetched only when it is about to be seen; the box keeps its height meanwhile. */
function SizeFigure({ v }: { v: ValidationStats }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref, '400px');
  return (
    <div ref={ref} className="mt-2 min-h-[18rem] rounded-card border border-ink/15 bg-white p-3">
      {near ? (
        <Suspense fallback={<Skeleton className="h-56" />}>
          <DetectionBySize bySize={v.by_size} />
        </Suspense>
      ) : (
        <Skeleton className="h-56" />
      )}
    </div>
  );
}

/** The accuracy section: both scorings, the pre-event baseline and the detection-by-size figure. */
export function SureSection() {
  const { stats } = useData();
  const s = ready(stats);
  const v = s?.validation ?? null;
  return (
    <section id="sure" aria-labelledby="sure-h" className={section}>
      <h2 id="sure-h" className="text-2xl font-semibold tracking-tight">{C.sure.heading}</h2>
      <div className={`${prose} mt-3`}>
        <p>{C.sure.p1}</p>
        <p>{C.sure.p2}</p>
        <p role="note" className="rounded-card border border-brand bg-white p-3 text-[15px] font-medium">{C.sure.splitNote}</p>
      </div>
      {stats.status === 'error' && <FileError file={stats.file} />}
      {stats.status === 'loading' && <Skeleton className="mt-4 h-40" />}
      {s && !v && <p className="mt-4 font-medium">{C.sure.noValidation}</p>}
      {s && v && (
        <div className="mt-6 space-y-8">
          <div>
            <ScoreTable v={v} original={s.validation_original} />
            <p className="mt-2 text-sm text-ink/80">
              {fill(C.sure.confusion, { tp: v.confusion.tp, fn: v.confusion.fn, fp: v.confusion.fp, tn: v.confusion.tn })}
            </p>
            <p className="mt-1 text-sm text-ink/80">
              {v.auc_ci_95
                ? fill(C.sure.aucInterval, { auc: fmtNumber(v.auc, 2), lo: fmtNumber(v.auc_ci_95[0], 2), hi: fmtNumber(v.auc_ci_95[1], 2) })
                : fill(C.sure.aucIntervalNone, { auc: fmtNumber(v.auc, 2) })}
            </p>
            <p className="mt-1 text-xs text-ink/70">{C.sure.ciNote}</p>
            {s.validation_original && <p className="mt-2 text-sm text-ink/80">{C.sure.aucNote}</p>}
          </div>

          <div>
            <h3 className="text-lg font-semibold">{C.sure.baselineHeading}</h3>
            <p className="mt-1 text-[17px] leading-relaxed">
              {fill(C.sure.baselineText, { baseline: fmtPercent(s.baseline_no_change_flag_rate, 1), post: fmtPercent(s.post_event_flag_rate, 1) })}
            </p>
            {baselineFails(s) && <p className="mt-2 rounded-card border border-brand bg-white p-3 text-[15px] font-semibold">{C.sure.baselineFails}</p>}
          </div>

          <figure>
            <h3 className="text-lg font-semibold">{C.sure.figure2}</h3>
            <SizeFigure v={v} />
            <figcaption className="mt-2 space-y-1 text-[15px]">
              <p>{C.sure.figure2Seeing}</p>
              <p className="text-xs text-ink/70">{C.sure.figure2Credit}</p>
            </figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}

/** The method in numbered steps, and what radar can and cannot show. */
export function MethodSection() {
  const { stats } = useData();
  const s = ready(stats);
  const windowPx = s?.params.highpass_px ?? 0;
  const windowM = windowPx > 1 && s ? windowPx * s.pixel_m : null;
  const steps = C.method.steps.filter((st) => windowM !== null || !st.text.includes('{window_m}'));
  return (
    <section id="method" aria-labelledby="method-h" className={`${section} border-t border-ink/10`}>
      <h2 id="method-h" className="text-2xl font-semibold tracking-tight">{C.method.heading}</h2>
      <ol className="mt-4 space-y-3">
        {steps.map((st, i) => (
          <li key={st.title} className="flex gap-3 rounded-card border border-ink/15 bg-white p-4">
            <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink text-sm" aria-hidden="true">{i + 1}</span>
            <div>
              <h3 className="font-semibold">{st.title}</h3>
              <p className="mt-0.5 text-[15px] text-ink/85">{fill(st.text, { window_m: windowM })}</p>
            </div>
          </li>
        ))}
      </ol>
      <h3 className="mt-8 text-lg font-semibold">{C.method.radarHeading}</h3>
      <p className="mt-1 text-[17px] leading-relaxed">{C.method.radarNote}</p>
      <p className="mt-4"><a className={ext} href={`${REPO}/blob/main/docs/method.md`} target="_blank" rel="noopener noreferrer">{C.method.full}</a></p>
    </section>
  );
}

const PRIORITY_MAX = 10;

/** One worklist: ranked rows, each with the plain-language reasons it scored what it did and a way to see it on the map. */
function PriorityList({ heading, items, onShow }: { heading: string; items: PriorityItem[]; onShow: (p: PriorityItem) => void }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-semibold">{heading}</h3>
      <ol className="mt-2 divide-y divide-ink/10 rounded-card border border-ink/15 bg-white">
        {items.slice(0, PRIORITY_MAX).map((it, i) => (
          <li key={it.id} className="flex gap-3 p-3">
            <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink text-sm" aria-hidden="true">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{it.name}</span>
                <span className="num text-sm font-semibold">{it.score} <span className="font-normal text-ink/70">{C.priority.scoreSuffix}</span></span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink/80">
                {it.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
              <button type="button" onClick={() => onShow(it)} className="mt-1.5 text-xs font-semibold underline decoration-brand decoration-2 underline-offset-2">{C.priority.openOnMap}</button>
            </div>
          </li>
        ))}
      </ol>
      {items.length > PRIORITY_MAX && (
        <p className="mt-1 text-xs text-ink/70">{fill(C.landslides.showing, { shown: PRIORITY_MAX, total: fmtNumber(items.length) })}</p>
      )}
    </div>
  );
}

/** Where to look first: road stretches and communities ordered by our own explainable score. Never a probability. */
export function PrioritySection() {
  const { roads, communities } = useData();
  const { focusFeature } = useApp();
  const r = ready(roads);
  const c = ready(communities);
  const roadItems = r ? priorityRoads(r) : [];
  const commItems = c ? priorityCommunities(c) : [];
  const loading = roads.status === 'loading' || communities.status === 'loading';
  const empty = !loading && roadItems.length === 0 && commItems.length === 0;
  return (
    <section id="priority" aria-labelledby="priority-h" className={`${section} border-t border-ink/10`}>
      <h2 id="priority-h" className="text-2xl font-semibold tracking-tight">{C.priority.heading}</h2>
      <div className={`${prose} mt-3`}>
        <p>{C.priority.intro}</p>
        <p role="note" className="rounded-card border border-brand bg-white p-3 text-[15px] font-medium">{C.priority.methodNote}</p>
      </div>
      {roads.status === 'error' && <FileError file={roads.file} />}
      {communities.status === 'error' && <FileError file={communities.file} />}
      {loading && <Skeleton className="mt-4 h-40" />}
      {empty && <p className="mt-4 font-medium">{C.priority.empty}</p>}
      {roadItems.length > 0 && <PriorityList heading={C.priority.roadHeading} items={roadItems} onShow={focusFeature} />}
      {commItems.length > 0 && <PriorityList heading={C.priority.communityHeading} items={commItems} onShow={focusFeature} />}
    </section>
  );
}

export function LimitsSection() {
  return (
    <section id="limits" aria-labelledby="limits-h" className={`${section} border-t border-ink/10`}>
      <h2 id="limits-h" className="text-2xl font-semibold tracking-tight">{C.limits.heading}</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[17px] leading-relaxed">
        {C.limits.items.map((t) => <li key={t}>{t}</li>)}
      </ol>
    </section>
  );
}

/** Footer: disclaimer, data credits, licence, AI use, repository. Nothing else. */
export function SiteFooter() {
  return (
    <footer id="data" className="scroll-mt-16 bg-ink px-4 py-10 text-sm text-white/90">
      <div className="mx-auto max-w-3xl xl:ml-14 xl:mr-0">
        <h2 className="text-lg font-semibold text-white">{C.footer.dataHeading}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {C.footer.credits.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <p className="mt-4 font-semibold text-white">{C.footer.disclaimer}</p>
        <p className="mt-2">{C.footer.licence}</p>
        <p className="mt-2">
          {C.footer.ai}{' '}
          <a className="underline" href={`${REPO}/blob/main/docs/si-log.md`} target="_blank" rel="noopener noreferrer">{C.footer.aiLink}</a>
          {' · '}
          <a className="underline" href={REPO} target="_blank" rel="noopener noreferrer">{C.footer.repo}</a>
        </p>
      </div>
    </footer>
  );
}
