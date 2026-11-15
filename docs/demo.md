# Demo kit

Material for judging: a 30-second introduction, a 3-minute demo script, short architecture and
method answers, the results and their limits, and ten likely judge questions with evidence-based
answers. Every number here comes from `web/public/data/panama-2026/stats.json` and
`data/validation/`; claims are kept to what the data and the sources support. Team: Ecliptic Nomads.
Challenge: "Dancing with the SARs".

## 30-second introduction

> "On 9 October 2026 a magnitude 7.7 earthquake struck Panama. Landslides buried roads and villages
> disappeared from the map. Optical satellites cannot see through cloud or forest — so we used radar.
>
> Cut Off compares NISAR L-band radar images from before and after the quake, finds forested slopes
> where the signal dropped, and turns those into a list of roads likely blocked and communities
> possibly cut off. It is fast, it works through cloud and at night, and it is honest: it also
> measures itself. On hand-marked check points it finds about a third of the landslides and almost no
> forest false alarms — and we show that one-in-three number right next to the results, not in a
> footnote. Every candidate is a lead to verify, never a confirmed landslide."

## 3-minute demo script

Timings are a guide. Open the live site, https://cut-off.bhogesara-ram23.workers.dev.

**0:00–0:25 — The answer first (Overview, top of page).**
"This is the whole result on one screen: 8,442 candidate landslides over 19.13 km², 92.2 km of road
likely blocked, and 102 communities possibly cut off. Read the wording carefully — *candidate*,
*likely*, *possibly*. Nobody saw these blockages; radar change is a lead to check, not a
confirmation."

**0:25–0:50 — Why radar (Figure 1: Optical and radar).**
"Same area, two instruments. Left: clouds and forest hide the ground. Right: radar sees through the
cloud and shows the change. That is why we use it for the first hours after a quake."

**0:50–1:50 — Walk the map (Map; six guided steps).**
Click through the steps in order:
- *Where it happened* — the star is the epicentre; the grey image is the radar view.
- *Slopes* — the red-orange shapes are candidate landslides, darker where more passes agree. Drag the
  before/after slider, and switch to the optical or mixed compare to see the same ground in
  Sentinel-2.
- *Roads* — "Likely blocked" means a candidate lies within 10 m of the road; "at risk" within 100 m.
- *Access* — a community is "possibly cut off" only when **every** mapped route to a nearby town
  crosses a likely-blocked road. Turn on the alternative-route and confidence notes.
- *How sure are we?* — the accuracy summary lives here too.

**1:50–2:20 — Inspection priorities (Priorities section).**
"With thousands of candidates, 'what first?' matters. Each road stretch and community gets a
transparent, configurable score from three plain factors: the evidence, how important the feature is,
and how much is involved. The weights are shown and can be changed. It is a *suggested order*, not a
probability of a disaster."

**2:20–2:40 — Honest accuracy (Accuracy section).**
"We marked 183 points on before/after Sentinel-2 — fresh scars and untouched forest — and scored
the method on a held-out half. It found 19 of 57 landslide points (33%) and flagged 0 of 34 forest
points; AUC 0.86. We also show the pre-event baseline: the same method flags 3.3% of forest slopes
without any quake, against 4.8% with it. We show that, because it is the honest picture."

**2:40–3:00 — Method, limits, links (Method, Limitations, Data and credits).**
"Everything is documented: the method with every setting, the limitations, an open read-only API, and
every data source with its licence. The data are provisional and this is a research demo, not an
official warning. Next: add more tracks, and pair radar with field reports to raise the hit rate."

## Architecture

Processing is offline; serving is thin and read-only. The pipeline never runs while a judge is
looking at the site.

| Layer | What it is | Where |
|---|---|---|
| Pipeline | Python: reads NISAR GCOV + Copernicus DEM + OpenStreetMap, detects candidates, joins to roads, analyses connectivity, scores priorities, writes small files | `pipeline/` (offline) |
| Result files | `event.json`, `pairs.json`, `landslides.geojson`, `roads.geojson`, `communities.geojson`, `stats.json` — one shared schema | `web/public/data/panama-2026/` |
| Website | React + TypeScript + Vite + Tailwind, MapLibre map, Recharts chart; reads the files directly, so it works with the API down | Cloudflare (static) |
| API | FastAPI + Pydantic, read-only, validates each file against its model before serving | Azure App Service |

The single source of truth is the output-file schema, mirrored in `pipeline/cutoff/contract.py`,
`api/models.py` and `web/src/lib/types.ts`, and checked by tests on all three sides, so a file that
does not match cannot reach a client.

## Methodology in one paragraph

For each before/after pair, take the change in HV (cross-polarised) radar signal in dB on a 20 m
grid, after speckle filtering; subtract that pair's own local mean change over a 220 m window so
region-wide shifts (wet soil) are not counted; mask to slopes ≥ 10° that were bright forest before
(HV ≥ −16 dB) and mark radar shadow/layover as unknown; keep pixels flagged by two of up to four
pairs where two can see them; drop patches under 3 pixels; each remaining connected patch is one
candidate landslide. Join candidates to OSM roads, then run a connectivity test for each community.
Full detail, every parameter and every setting tried is in [method.md](method.md).

## Results and limitations

**Results.** 8,442 candidate landslides (19.13 km²); 92.2 km of road likely blocked; 102 of 460
mapped communities possibly cut off (337 reachable, 21 unknown). Held-out half, revised method
(57 landslide points, 34 forest points): 33% found, 0% forest flagged, AUC 0.86; first scoring of the
original method on the same half: 21%, 3%, AUC 0.55. Detection rises with size: small 20% (n = 30),
medium 48% (n = 27).

**Limitations (the ones judges should hear).** The validation is a random split of points within one
study area, labelled from optical imagery and checked by eye — not independent geographic validation
and not field validation; nearby points may share conditions. Most check-point landslides are small
and many are missed. Forest points were chosen as clearly intact forest, so the measured false-alarm
rate is likely optimistic. "Likely blocked" is inferred from proximity to a candidate; nobody saw the
blockage. OSM road data is volunteer-contributed. The radar is PROVISIONAL. See
[../README.md](../README.md#limits).

## Ten likely judge questions

1. **"Is that a confirmed landslide?"** No. A candidate is a patch of flagged radar pixels — a lead
   to verify. Vegetation, soil moisture and viewing geometry also change the signal. We say this
   everywhere it matters: the map, the method, the limits and the README.

2. **"Why radar instead of optical?"** Cloud and forest block optical satellites, and the first hours
   after an earthquake are exactly when it is cloudy and dark. Radar sees through cloud and at night.
   We still use Sentinel-2 — but to mark check points and to draw the compare images, never to detect.

3. **"33% is weak. Why should anyone use this?"** Because it is stated up front. The value is a fast,
   transparent *first list* of where to look, with every limit attached, not a complete inventory. We
   also show where it works better: 48% of medium landslides versus 20% of small ones.

4. **"How did you validate, and could it be overfit?"** 183 points were marked on before/after
   Sentinel-2, split in half at random, committed before scoring, and the settings were chosen on the
   tuning half only — a test enforces that the held-out half never reaches tuning. The held-out half
   was scored twice and both results are kept on file. We state plainly that it is not independent
   geographic validation.

5. **"What about the pre-event baseline?"** We ran the same method on two passes from *before* the
   quake. It flags 3.3% of forested slopes without an earthquake, against 4.8% with one — so single
   detections are weak evidence, and we say so rather than hiding the failing check.

6. **"Can radar see every slope?"** No. Slopes facing away from the radar or hidden behind ridges are
   shadow or layover, and we mark them unknown (grey) instead of guessing.

7. **"How do you know a road is blocked?"** We do not claim to know. A road is "likely blocked" only
   if a candidate landslide lies within 10 m of it — an inference from proximity, clearly labelled.
   Collapsed bridges and sinking roads are not detected at all.

8. **"Does the score mean a community will be cut off?"** No. It is a weighted mean of evidence,
   importance and extent, with the weights shown — a suggested inspection order, not a probability.
   A community is called "possibly cut off" only after a connectivity test shows every mapped route
   to a nearby town crosses a likely-blocked road; one open alternative route makes it "reachable".

9. **"What are the biggest weaknesses?"** Small landslides (many under 100 m, near the 20 m pixel),
   the optimistic forest sample, volunteer-contributed OSM roads, and PROVISIONAL radar calibration.
   We list these in the Limitations section rather than in a footnote.

10. **"Is it reproducible and open?"** Yes. All code is in the repository with the settings used, the
    nine NISAR granule IDs, the check-point file and both scoring files; the result files are
    committed so the site and the read-only API run without any download; every dataset and library is
    listed with its licence in [citations.md](citations.md).
