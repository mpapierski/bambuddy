import { Cloud, CloudOff, Cog, Loader2, Package, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  type PresetRef,
  type PresetSource,
  type SliceBundleSpec,
  type SliceJobProgress,
  type SliceRequest,
  type SlicerBundle,
  type SlicerCloudStatus,
  type UnifiedPreset,
  type UnifiedPresetsBySlot,
  type UnifiedPresetsResponse,
} from '../api/client';
import { useSliceJobTracker } from '../contexts/SliceJobTrackerContext';
import { useToast } from '../contexts/ToastContext';
import { PlatePickerModal } from './PlatePickerModal';
import type { PlateFilament } from '../types/plates';
import { normalizeColorForCompare, colorsAreSimilar } from '../utils/amsHelpers';

export type SliceSource =
  | { kind: 'libraryFile'; id: number; filename: string }
  | { kind: 'archive'; id: number; filename: string };

interface SliceModalProps {
  source: SliceSource;
  onClose: () => void;
}

type Slot = 'printer' | 'process' | 'filament';

// SliceModal-specific tier priority: local (imported) → cloud → standard.
// Imported profiles are surfaced first because they're the user's curated
// picks (often colour/type-tagged), cloud is second since names alone can't
// drive metadata-aware match, standard is the bundled fallback. This is
// distinct from the listing endpoint's dedup order and only affects what
// the SliceModal renders / pre-picks.
const SLICE_MODAL_TIER_ORDER = ['local', 'cloud', 'standard'] as const;

function pickDefault(by: UnifiedPresetsResponse, slot: Slot): PresetRef | null {
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    const list = by[tier][slot];
    if (list.length > 0) {
      return { source: list[0].source, id: list[0].id };
    }
  }
  return null;
}

const TIER_BONUS: Record<PresetSource, number> = {
  local: 1.5,
  cloud: 1.0,
  standard: 0.5,
};

const DEVICE_KIND_ORDER = [
  'H2D Pro',
  'H2D',
  'X1C',
  'X1E',
  'X1',
  'P1S',
  'P1P',
  'A1 Mini',
  'A1',
] as const;

const DEVICE_KIND_SORT: Map<string, number> = new Map(DEVICE_KIND_ORDER.map((kind, idx) => [kind, idx]));

const DEVICE_ALIASES: Array<[string, string[]]> = [
  ['H2D Pro', ['h2dpro']],
  ['H2D', ['h2d']],
  ['X1C', ['x1carbon', 'x1c']],
  ['X1E', ['x1e']],
  ['X1', ['x1']],
  ['P1S', ['p1s']],
  ['P1P', ['p1p']],
  ['A1 Mini', ['a1mini', 'a1min']],
  ['A1', ['a1']],
];

function compactDeviceToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeDeviceKind(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = compactDeviceToken(value);
  if (!compact) return null;
  for (const [kind, aliases] of DEVICE_ALIASES) {
    if (aliases.some((alias) => compact.includes(alias))) return kind;
  }
  return null;
}

function sortDeviceKinds(values: Iterable<string | null | undefined>): string[] {
  const unique = [...new Set([...values].filter((v): v is string => !!v))];
  return unique.sort((a, b) => {
    const ai = DEVICE_KIND_SORT.get(a) ?? 10_000;
    const bi = DEVICE_KIND_SORT.get(b) ?? 10_000;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function presetMatchesDevice(preset: UnifiedPreset, deviceKind: string | null): boolean {
  if (!deviceKind) return true;
  return (
    preset.device_kind === deviceKind ||
    (preset.compatible_device_kinds ?? []).includes(deviceKind)
  );
}

function filterPresetsForDevice(
  data: UnifiedPresetsResponse,
  deviceKind: string | null,
): UnifiedPresetsResponse {
  if (!deviceKind) return data;
  return {
    ...data,
    cloud: {
      ...data.cloud,
      printer: data.cloud.printer.filter((p) => presetMatchesDevice(p, deviceKind)),
      process: data.cloud.process.filter((p) => presetMatchesDevice(p, deviceKind)),
    },
    local: {
      ...data.local,
      printer: data.local.printer.filter((p) => presetMatchesDevice(p, deviceKind)),
      process: data.local.process.filter((p) => presetMatchesDevice(p, deviceKind)),
    },
    standard: {
      ...data.standard,
      printer: data.standard.printer.filter((p) => presetMatchesDevice(p, deviceKind)),
      process: data.standard.process.filter((p) => presetMatchesDevice(p, deviceKind)),
    },
  };
}

function getPreset(data: UnifiedPresetsResponse, slot: Slot, ref: PresetRef | null): UnifiedPreset | null {
  if (!ref) return null;
  return data[ref.source][slot].find((p) => p.id === ref.id) ?? null;
}

function presetRefExists(data: UnifiedPresetsResponse, slot: Slot, ref: PresetRef | null): boolean {
  return getPreset(data, slot, ref) != null;
}

function stripProfilePrefix(value: string): string {
  return value.replace(/^#\s*/, '').trim();
}

function findPresetRefByName(data: UnifiedPresetsResponse, slot: Slot, name: string | null | undefined): PresetRef | null {
  if (!name) return null;
  const target = stripProfilePrefix(name).toLowerCase();
  if (!target) return null;
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    const match = data[tier][slot].find((p) => stripProfilePrefix(p.name).toLowerCase() === target);
    if (match) return { source: match.source, id: match.id };
  }
  return null;
}

function pickFilamentForSlot(
  by: UnifiedPresetsResponse,
  required: { type: string; color: string },
): PresetRef | null {
  // Score every filament preset against the plate slot's required (type,
  // colour) and pick the highest. Mirrors the AMS slot-mapping match in the
  // print/schedule modal: type match dominates, exact-colour-match bumps over
  // similar-colour-match, and a small per-tier bonus breaks ties so cloud
  // user customisations win over standard bundled fallbacks of equal merit.
  const reqType = required.type.trim().toUpperCase();
  const reqColor = normalizeColorForCompare(required.color);

  let best: { ref: PresetRef; score: number } | null = null;
  for (const tier of SLICE_MODAL_TIER_ORDER) {
    for (const p of by[tier].filament) {
      let score = 0;
      const presetType = (p.filament_type ?? '').trim().toUpperCase();
      const presetColor = normalizeColorForCompare(p.filament_colour ?? '');
      if (reqType && presetType && reqType === presetType) score += 10;
      if (reqColor && presetColor) {
        if (presetColor === reqColor) score += 5;
        else if (colorsAreSimilar(p.filament_colour ?? '', required.color)) score += 2;
      }
      score += TIER_BONUS[tier];
      if (best == null || score > best.score) {
        best = { ref: { source: p.source, id: p.id }, score };
      }
    }
  }
  // Fall back to plain priority pick if every preset scored 0+tier (i.e. no
  // metadata matched). The fallback is exactly the single-color default —
  // first preset in the highest-priority non-empty tier.
  if (best == null) return pickDefault(by, 'filament');
  return best.ref;
}

function toRefValue(ref: PresetRef | null): string {
  // The HTML `<select>` value space is flat strings; encode source + id so
  // the same preset name can live in multiple tiers without collision.
  return ref ? `${ref.source}:${ref.id}` : '';
}

function fromRefValue(raw: string): PresetRef | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const source = raw.slice(0, idx) as PresetSource;
  const id = raw.slice(idx + 1);
  if (source !== 'cloud' && source !== 'local' && source !== 'standard') return null;
  return { source, id };
}

function cssFilamentColor(color: string | null | undefined): string {
  const raw = (color ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{8}$/i.test(raw)) return raw.slice(0, 7);
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  if (/^[0-9a-f]{8}$/i.test(raw)) return `#${raw.slice(0, 6)}`;
  return 'transparent';
}

// Inline spinner for the filament-requirements query. The backend runs a
// preview slice on first open of an unsliced project file (cached after);
// on a complex multi-color model that's a real slice — multi-second to
// multi-minute. The static "Analyzing plate filaments…" string left
// users wondering whether anything was happening, so the spinner now
// shows elapsed seconds, polls the sidecar's --pipe progress (via the
// /slicer/preview-progress proxy) for live stage + percent, and after ~5s
// surfaces a "this is a one-time slice — repeat opens are instant"
// note so users don't worry it'll be slow forever.
//
// requestId: a UUID generated by the modal when the filament-requirements
// fetch starts. Forwarded to the sidecar via the API call AND used here
// to poll the matching progress snapshot. Same id, two consumers.
function FilamentAnalysisSpinner({
  requestId,
  sourceName,
}: {
  requestId: string;
  sourceName: string;
}) {
  const { t } = useTranslation();
  const { showPersistentToast, dismissToast } = useToast();
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<SliceJobProgress | null>(null);
  // Defensive decode — see prettifyFilename comment in SliceJobTrackerContext.
  let prettyName = sourceName;
  try {
    prettyName = decodeURIComponent(sourceName);
  } catch {
    /* keep raw on malformed encoding */
  }

  // Elapsed-time tick.
  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Progress polling — once per second while the spinner is mounted.
  // Mirrors the slice-job tracker's cadence. Sidecar 404s during the
  // race window between fetch start and progressStore.start() are
  // swallowed by the API method (returns null) so we keep polling.
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      if (cancelled) return;
      const snap = await api.getPreviewSliceProgress(requestId);
      if (!cancelled && snap) setProgress(snap);
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [requestId]);

  // Mirror the spinner's contents into a persistent toast so the user
  // sees activity even when their cursor is elsewhere on the page.
  // Dismissed in the parent's effect when the requirements arrive.
  const toastId = `slice-preview-${requestId}`;
  useEffect(() => {
    const hasUseful = progress && progress.stage && progress.total_percent > 0;
    const elapsedStr = formatElapsed(elapsed);
    if (hasUseful) {
      showPersistentToast(
        toastId,
        t(
          'slice.previewWithProgress',
          'Analyzing {{name}} — {{stage}} ({{percent}}%) — {{elapsed}}',
          {
            name: prettyName,
            stage: progress!.stage,
            percent: Math.min(100, Math.max(0, Math.round(progress!.total_percent))),
            elapsed: elapsedStr,
          },
        ),
        'loading',
      );
    } else {
      showPersistentToast(
        toastId,
        t('slice.previewToast', 'Analyzing {{name}} — {{elapsed}}', {
          name: prettyName,
          elapsed: elapsedStr,
        }),
        'loading',
      );
    }
    return () => {
      dismissToast(toastId);
    };
  }, [elapsed, progress, prettyName, showPersistentToast, dismissToast, t, toastId]);

  const stage = progress?.stage;
  const percent = progress?.total_percent;
  const inlineLabel =
    stage && typeof percent === 'number' && percent > 0
      ? `${stage} (${Math.min(100, Math.max(0, Math.round(percent)))}%)`
      : t('slice.analyzingPlateFilaments', 'Analyzing plate filaments…');
  return (
    <div className="flex flex-col gap-1 text-bambu-gray text-sm py-2">
      <div className="flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {inlineLabel}
        <span className="text-xs tabular-nums">{elapsed}s</span>
      </div>
      {elapsed >= 5 && (
        <div className="text-xs text-bambu-gray/70 pl-6">
          {t(
            'slice.analyzingPlateFilamentsHint',
            'Running a preview slice to discover which AMS slots this plate uses. Cached after — re-opening is instant.',
          )}
        </div>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export function SliceModal({ source, onClose }: SliceModalProps) {
  const { t } = useTranslation();
  const { trackJob } = useSliceJobTracker();
  const sourceIs3mf = source.filename.toLowerCase().endsWith('.3mf');

  const [selectedDeviceKind, setSelectedDeviceKind] = useState<string | null>(null);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [printerPreset, setPrinterPreset] = useState<PresetRef | null>(null);
  const [processPreset, setProcessPreset] = useState<PresetRef | null>(null);
  // One filament ref per plate slot, in plate order. For STL / single-plate /
  // single-color sources this is a one-element array; multi-color 3MFs get one
  // entry per AMS slot the plate uses. Pre-pick (effect below) initialises
  // each slot from the source plate's required (type, colour).
  const [filamentPresets, setFilamentPresets] = useState<(PresetRef | null)[]>([]);
  // Bundle dispatch (alternative to the preset triplet). When non-null, the
  // SliceModal hides the cloud/local/standard preset dropdowns and shows
  // bundle-scoped pickers (process + per-slot filament from the chosen
  // bundle's contents). Submit routes through the backend's bundle dispatch
  // (`SliceRequest.bundle`) which skips PresetRef resolution.
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [bundleProcessName, setBundleProcessName] = useState<string | null>(null);
  const [bundleFilamentNames, setBundleFilamentNames] = useState<(string | null)[]>([]);
  const [filamentMode, setFilamentMode] = useState<'embedded' | 'override'>(
    () => (sourceIs3mf ? 'embedded' : 'override'),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // null = single-plate / non-3MF / unknown plate layout. 0 = all plates,
  // matching Bambu Studio CLI's `--slice 0`; positive numbers are 1-indexed
  // plate numbers.
  const [selectedPlate, setSelectedPlate] = useState<number | null>(null);

  const platesQuery = useQuery({
    queryKey: ['slicePlates', source.kind, source.id],
    queryFn: async () => {
      if (source.kind === 'libraryFile') {
        return api.getLibraryFilePlates(source.id);
      }
      return api.getArchivePlates(source.id);
    },
    staleTime: 60_000,
  });

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
    staleTime: 60_000,
  });

  const isMultiPlate =
    !!platesQuery.data?.is_multi_plate && (platesQuery.data?.plates?.length ?? 0) > 1;
  const needsPlatePicker = isMultiPlate && selectedPlate == null;
  const sourceDeviceKind =
    platesQuery.data?.source_device_kind ?? normalizeDeviceKind(platesQuery.data?.source_printer_model);

  useEffect(() => {
    setFilamentMode(sourceIs3mf ? 'embedded' : 'override');
    setSelectedPlate(null);
    setSelectedDeviceKind(null);
    setPrinterPreset(null);
    setProcessPreset(null);
    setFilamentPresets([]);
    setSelectedBundleId(null);
    setErrorMessage(null);
  }, [source.kind, source.id, source.filename, sourceIs3mf]);

  // Per-plate filament requirements via the same endpoint the print/schedule
  // modal uses. Reusing it here keeps the SliceModal honest with whatever
  // logic that endpoint applies (slice_info parsing, future enhancements for
  // unsliced project files, dual-nozzle fields, etc.) instead of duplicating
  // extraction. `plate_id` is omitted for all-plates, which lets the backend
  // return the project-wide filament list and keeps `--slice 0` aligned with
  // the final slice request.
  const effectivePlateId = selectedPlate && selectedPlate > 0 ? selectedPlate : undefined;
  // Generate a request_id per (source, plate) pair so the backend's
  // preview-slice and the FilamentAnalysisSpinner's progress poll share
  // the same id. useMemo keeps it stable across renders within the same
  // pair; switching plates regenerates so a stale poll doesn't bleed
  // progress between plates.
  const previewRequestId = useMemo(() => {
    const random =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Tag the id with the (source, plate) so logs/Network panel show which
    // pair owns the poll. Also lets the lint rule see the deps in use.
    return `${source.kind}-${source.id}-p${effectivePlateId ?? 'all'}-${random}`;
  }, [source.kind, source.id, effectivePlateId]);
  const filamentReqsQuery = useQuery({
    queryKey: ['sliceFilamentReqs', source.kind, source.id, effectivePlateId],
    queryFn: async () => {
      if (source.kind === 'libraryFile') {
        return api.getLibraryFileFilamentRequirements(source.id, effectivePlateId, previewRequestId);
      }
      return api.getArchiveFilamentRequirements(source.id, effectivePlateId, previewRequestId);
    },
    enabled: !platesQuery.isLoading && !needsPlatePicker,
    staleTime: 60_000,
  });

  // Filament slot list for the active plate. Falls back to one synthetic slot
  // for STL/STEP and any "no metadata available" case so the modal still
  // works (single dropdown, mono-color slice).
  const filamentSlots = useMemo<PlateFilament[]>(() => {
    const reqs = filamentReqsQuery.data?.filaments ?? [];
    if (reqs.length > 0) return reqs as PlateFilament[];
    return [
      { slot_id: 1, type: '', color: '', used_grams: 0, used_meters: 0 },
    ];
  }, [filamentReqsQuery.data]);

  const presetsQuery = useQuery({
    queryKey: ['slicerPresets'],
    queryFn: () => api.getSlicerPresets(),
    staleTime: 60_000,
    enabled: !platesQuery.isLoading && !needsPlatePicker,
  });

  // Imported Printer Preset Bundles (.bbscfg). Empty list when no sidecar
  // configured / no bundles imported yet; the bundle picker hides itself
  // in that case so users without bundles see the original modal layout.
  const bundlesQuery = useQuery({
    queryKey: ['slicerBundles'],
    queryFn: api.listSlicerBundles,
    staleTime: 60_000,
    enabled: !platesQuery.isLoading && !needsPlatePicker,
    // Bundle listing is a hard 503 when the sidecar is offline; don't
    // retry tight loops in that case.
    retry: false,
  });
  const selectedBundle: SlicerBundle | null = useMemo(() => {
    if (!selectedBundleId || !bundlesQuery.data) return null;
    return bundlesQuery.data.find((b) => b.id === selectedBundleId) ?? null;
  }, [selectedBundleId, bundlesQuery.data]);
  const isBundleMode = selectedBundle != null;
  const ownedDeviceKinds = useMemo(() => {
    return sortDeviceKinds(
      (printersQuery.data ?? [])
        .filter((printer) => printer.is_active !== false)
        .map((printer) => normalizeDeviceKind(printer.model ?? printer.name)),
    );
  }, [printersQuery.data]);
  const availableDeviceKinds = useMemo(() => {
    return sortDeviceKinds(presetsQuery.data?.available_device_kinds ?? []);
  }, [presetsQuery.data]);
  const deviceOptions = useMemo(() => {
    if (!ownedOnly) return availableDeviceKinds;
    const owned = new Set(ownedDeviceKinds);
    return availableDeviceKinds.filter((kind) => owned.has(kind));
  }, [availableDeviceKinds, ownedDeviceKinds, ownedOnly]);
  const filteredPresetData = useMemo(() => {
    if (!presetsQuery.data) return null;
    const filterDevice =
      ownedOnly && availableDeviceKinds.length > 0 && deviceOptions.length === 0
        ? '__no-owned-device__'
        : selectedDeviceKind;
    return filterPresetsForDevice(presetsQuery.data, filterDevice);
  }, [availableDeviceKinds.length, deviceOptions.length, ownedOnly, presetsQuery.data, selectedDeviceKind]);

  useEffect(() => {
    if (!presetsQuery.data) return;
    if (deviceOptions.length === 0) {
      if (selectedDeviceKind != null) setSelectedDeviceKind(null);
      return;
    }
    if (selectedDeviceKind && deviceOptions.includes(selectedDeviceKind)) return;
    const sourceDefault =
      sourceDeviceKind && deviceOptions.includes(sourceDeviceKind) ? sourceDeviceKind : null;
    const ownedDefault = ownedDeviceKinds.find((kind) => deviceOptions.includes(kind)) ?? null;
    setSelectedDeviceKind(sourceDefault ?? ownedDefault ?? deviceOptions[0] ?? null);
  }, [deviceOptions, ownedDeviceKinds, presetsQuery.data, selectedDeviceKind, sourceDeviceKind]);

  // Printer / process pre-pick: see SLICE_MODAL_TIER_ORDER. Runs once when
  // presets first arrive; subsequent re-renders preserve any manual choice.
  useEffect(() => {
    if (!filteredPresetData) return;
    setPrinterPreset((current) =>
      presetRefExists(filteredPresetData, 'printer', current)
        ? current
        : pickDefault(filteredPresetData, 'printer'),
    );
    setProcessPreset((current) => {
      if (presetRefExists(filteredPresetData, 'process', current)) return current;
      const detected = findPresetRefByName(
        filteredPresetData,
        'process',
        platesQuery.data?.source_process_profile_name,
      );
      return detected ?? pickDefault(filteredPresetData, 'process');
    });
  }, [filteredPresetData, platesQuery.data?.source_process_profile_name]);

  // Filament pre-pick: re-runs whenever the active filament-slot count
  // changes (plate selection, single-plate metadata arriving). For each slot
  // we score every available filament preset against the slot's required
  // (type, colour) and keep the highest match. Slot count mismatch → reset
  // and re-pick everything; same length → preserve any user override.
  useEffect(() => {
    if (!presetsQuery.data) return;
    const data = presetsQuery.data;
    setFilamentPresets((current) => {
      if (current.length === filamentSlots.length && current.every((r) => r != null)) {
        return current;
      }
      return filamentSlots.map((slot) =>
        pickFilamentForSlot(data, { type: slot.type, color: slot.color }),
      );
    });
  }, [presetsQuery.data, filamentSlots]);

  // Bundle-mode auto-pick: when the user picks a bundle (or the slot count
  // changes after the picker is open), default the process to the bundle's
  // first listed process and every filament slot to the bundle's first
  // listed filament. Plain string match — bundles store delta files keyed
  // by user preset name, no scoring needed since the user picks per-slot
  // afterwards if the default is wrong.
  useEffect(() => {
    if (!selectedBundle) {
      // Reset bundle picks when bundle is cleared so re-selection
      // re-defaults rather than carrying stale values.
      setBundleProcessName(null);
      setBundleFilamentNames([]);
      return;
    }
    setBundleProcessName((current) => {
      // Preserve a manual pick if it still exists in the bundle; otherwise
      // re-default. Same shape as the preset auto-pick effect above.
      if (current && selectedBundle.process.includes(current)) return current;
      return selectedBundle.process[0] ?? null;
    });
    setBundleFilamentNames((current) => {
      if (current.length === filamentSlots.length && current.every((n) => n != null)) {
        return current;
      }
      const fallback = selectedBundle.filament[0] ?? null;
      return filamentSlots.map((_, i) => current[i] ?? fallback);
    });
  }, [selectedBundle, filamentSlots]);

  const enqueueMutation = useMutation({
    mutationFn: async () => {
      let body: SliceRequest;
      if (isBundleMode) {
        // Bundle dispatch path. The selected bundle's first printer is the
        // implicit printer choice (every .bbscfg carries exactly one).
        if (
          !selectedBundle ||
          !bundleProcessName ||
          bundleFilamentNames.length === 0 ||
          bundleFilamentNames.some((n) => n == null)
        ) {
          throw new Error(t('slice.bundleAllRequired', 'Bundle process and every filament slot must be picked'));
        }
        const bundleSpec: SliceBundleSpec = {
          bundle_id: selectedBundle.id,
          printer_name: selectedBundle.printer[0] ?? selectedBundle.printer_preset_name,
          process_name: bundleProcessName,
          filament_names: bundleFilamentNames as string[],
        };
        body = {
          bundle: bundleSpec,
          ...(selectedPlate != null ? { plate: selectedPlate } : {}),
        };
      } else {
        if (!printerPreset || !processPreset) {
          throw new Error(t('slice.printerProcessRequired', 'Printer and process presets must be selected'));
        }
        if (filamentMode === 'embedded') {
          if (!sourceIs3mf) {
            throw new Error(t('slice.embeddedFilament3mfOnly', 'Embedded filament mode is only available for 3MF sources'));
          }
          body = {
            printer_preset: printerPreset,
            process_preset: processPreset,
            filament_mode: 'embedded',
            ...(selectedPlate != null ? { plate: selectedPlate } : {}),
          };
        } else {
          if (filamentPresets.length === 0 || filamentPresets.some((r) => r == null)) {
            throw new Error(t('slice.allPresetsRequired', 'All presets must be selected'));
          }
          body = {
            printer_preset: printerPreset,
            process_preset: processPreset,
            // The first slot also goes into the legacy singular field so the
            // backend's older callers / clients keep behaving the same — the
            // backend validator prefers `filament_presets` when both are set.
            filament_preset: filamentPresets[0] as PresetRef,
            filament_presets: filamentPresets as PresetRef[],
            filament_mode: 'override',
            ...(selectedPlate != null ? { plate: selectedPlate } : {}),
          };
        }
      }
      if (source.kind === 'libraryFile') {
        return api.sliceLibraryFile(source.id, body);
      }
      return api.sliceArchive(source.id, body);
    },
    onSuccess: (enqueue) => {
      trackJob(enqueue.job_id, source.kind, source.filename);
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    },
  });

  // Pre-slice compatibility warning. We allow the CLI `--load-settings`
  // path to try converting between devices, but surface the mismatch because
  // failures here are common and the user may want to pick a matching profile.
  const sourcePrinterModel = platesQuery.data?.source_printer_model ?? null;
  const printerProfileName = isBundleMode
    ? selectedBundle?.printer_preset_name.replace(/^# /, '') ?? null
    : printerPreset
      ? presetsQuery.data?.[printerPreset.source].printer.find((p) => p.id === printerPreset.id)?.name
      : null;
  const targetDeviceKind =
    selectedDeviceKind ?? normalizeDeviceKind(printerProfileName ?? selectedBundle?.printer_preset_name);
  const printerMismatch =
    !!sourceDeviceKind && !!targetDeviceKind && sourceDeviceKind !== targetDeviceKind;

  // Slice button stays disabled until *all* of these hold:
  //   - the preview slice / embedded-metadata read has succeeded so we know
  //     the per-plate filament slot list is final
  //     (filamentReqsQuery.isSuccess). Without this gate the synthetic
  //     single-slot fallback would auto-enable the button on opaque
  //     defaults, before the slicer has even returned the real slot map.
  //   - printer + process picked
  //   - embedded mode is using a 3MF source, or every override filament slot
  //     has a profile (the auto-pick fills these once filamentSlots arrives)
  const overrideFilamentsReady =
    filamentPresets.length > 0 && filamentPresets.every((r) => r != null);
  const embeddedFilamentsReady = sourceIs3mf && filamentMode === 'embedded';
  const isReady = isBundleMode
    ? selectedBundle != null &&
      bundleProcessName != null &&
      filamentReqsQuery.isSuccess &&
      bundleFilamentNames.length > 0 &&
      bundleFilamentNames.every((n) => n != null)
    : printerPreset != null &&
      processPreset != null &&
      filamentReqsQuery.isSuccess &&
      (embeddedFilamentsReady || overrideFilamentsReady);
  const isEnqueuing = enqueueMutation.isPending;
  const selectedPlateLabel = useMemo(() => {
    if (selectedPlate === 0) return t('slice.allPlates', 'All plates');
    if (selectedPlate == null) return null;
    const plate = platesQuery.data?.plates?.find((p) => p.index === selectedPlate);
    return plate?.name
      ? `${t('archives.platePicker.plateLabel', { index: selectedPlate })} — ${plate.name}`
      : t('archives.platePicker.plateLabel', { index: selectedPlate });
  }, [platesQuery.data?.plates, selectedPlate, t]);

  if (needsPlatePicker && platesQuery.data) {
    return (
      <PlatePickerModal
        plates={platesQuery.data.plates}
        includeAll
        title={t('slice.selectPlate', 'Select plate to slice')}
        hint={t('slice.selectPlateHint', 'Pick a plate to slice, or choose All plates.')}
        onSelect={(plateIndex) => setSelectedPlate(plateIndex)}
        onClose={onClose}
      />
    );
  }

  // Main slicing form. While the plates query is in-flight we still render
  // the shell because the presets query is gated on it; the loader covers both.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!isEnqueuing) onClose();
      }}
    >
      <div
        className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-bambu-dark-tertiary/40">
          <div className="min-w-0">
            <h3 className="text-white font-medium flex items-center gap-2">
              <Cog className="w-4 h-4" />
              {t('slice.title', 'Slice model')}
            </h3>
            <p className="text-xs text-bambu-gray mt-1 truncate" title={source.filename}>
              {source.filename}
              {selectedPlateLabel ? ` • ${selectedPlateLabel}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={isEnqueuing}
            className="flex-shrink-0 text-bambu-gray hover:text-white transition-colors disabled:opacity-50"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Preset listing loader — printer/process dropdowns can't render
              without it. Plate query reuses the same spinner since it's
              also blocking. */}
          {(platesQuery.isLoading || presetsQuery.isLoading) && (
            <div className="flex items-center gap-2 text-bambu-gray text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('slice.loadingPresets', 'Loading presets…')}
            </div>
          )}

          {presetsQuery.isError && (
            <div className="text-sm text-red-400" role="alert">
              {t(
                'slice.presetsLoadFailed',
                'Failed to load presets. Open Settings → Profiles to import them, or sign in to Bambu Cloud.',
              )}
            </div>
          )}

          {presetsQuery.data && (
            <>
              <CloudStatusBanner status={presetsQuery.data.cloud_status} />
              {availableDeviceKinds.length > 0 && (
                <div className="space-y-2">
                  <label className="block">
                    <span className="block text-sm text-bambu-gray mb-1">
                      {t('slice.device', 'Device')}
                    </span>
                    <select
                      value={selectedDeviceKind ?? ''}
                      onChange={(e) => setSelectedDeviceKind(e.target.value || null)}
                      disabled={isEnqueuing || deviceOptions.length === 0}
                      className="w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-gray disabled:opacity-50"
                    >
                      {deviceOptions.length === 0 ? (
                        <option value="">
                          {t('slice.noOwnedDeviceKinds', 'No owned device kinds with profiles')}
                        </option>
                      ) : (
                        deviceOptions.map((kind) => (
                          <option key={kind} value={kind}>
                            {kind}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-2 text-xs text-bambu-gray">
                    <input
                      type="checkbox"
                      checked={ownedOnly}
                      onChange={(e) => setOwnedOnly(e.target.checked)}
                      disabled={isEnqueuing || printersQuery.isLoading}
                      className="rounded border-bambu-dark-tertiary bg-bambu-dark text-bambu-green focus:ring-bambu-green"
                    />
                    {t('slice.ownedDeviceKindsOnly', 'Owned device kinds only')}
                  </label>
                </div>
              )}
              {/* Bundle picker — only renders when at least one .bbscfg has
                  been imported via Settings → Slicer Bundles. Lets the user
                  trade the cloud/local/standard tier for a single curated
                  triplet from a previously-uploaded BambuStudio bundle. */}
              {bundlesQuery.data && bundlesQuery.data.length > 0 && (
                <BundlePicker
                  bundles={bundlesQuery.data}
                  selectedId={selectedBundleId}
                  onChange={setSelectedBundleId}
                  disabled={isEnqueuing}
                />
              )}
              {/* Preset triplet — hidden when a bundle is selected so the
                  user only sees one tier at a time. The bundle's process +
                  filament dropdowns render below in their stead. */}
              {!isBundleMode && (
                <>
                  <PresetDropdown
                    label={t('slice.printer', 'Printer profile')}
                    slot="printer"
                    data={filteredPresetData ?? presetsQuery.data}
                    value={printerPreset}
                    onChange={setPrinterPreset}
                    disabled={isEnqueuing}
                  />
                  <PresetDropdown
                    label={t('slice.process', 'Process profile')}
                    slot="process"
                    data={filteredPresetData ?? presetsQuery.data}
                    value={processPreset}
                    onChange={setProcessPreset}
                    disabled={isEnqueuing}
                  />
                </>
              )}
              {isBundleMode && selectedBundle && (
                <>
                  {/* Bundle's printer is implicit (each .bbscfg has exactly
                      one). Show it as a read-only label so the user can
                      verify the printer they're slicing for. */}
                  <div>
                    <label className="block text-sm text-bambu-gray mb-1">
                      {t('slice.printer', 'Printer profile')}
                    </label>
                    <div className="px-3 py-2 rounded-md bg-bambu-dark/40 border border-bambu-dark-tertiary text-white text-sm">
                      {selectedBundle.printer_preset_name}
                    </div>
                  </div>
                  <BundleStringDropdown
                    label={t('slice.process', 'Process profile')}
                    options={selectedBundle.process}
                    value={bundleProcessName}
                    onChange={setBundleProcessName}
                    disabled={isEnqueuing}
                  />
                </>
              )}
              {/* Filament reqs may need a server-side preview-slice for
                  unsliced project files (single-pass, then cached). Show a
                  scoped spinner so the user sees the printer/process
                  dropdowns instead of an opaque "Loading presets…" wait. */}
              {filamentReqsQuery.isLoading ? (
                <FilamentAnalysisSpinner
                  requestId={previewRequestId}
                  sourceName={source.filename}
                />
              ) : isBundleMode && selectedBundle ? (
                filamentSlots.map((slot, idx) => {
                  const isUsed = slot.used_in_plate !== false;
                  const baseLabel =
                    filamentSlots.length > 1
                      ? t('slice.filamentSlot', {
                          index: idx + 1,
                          type: slot.type,
                          defaultValue: `Filament ${idx + 1} (${slot.type || ''})`,
                        })
                      : t('slice.filament', 'Filament profile');
                  const label = isUsed
                    ? baseLabel
                    : `${baseLabel} ${t('slice.notUsedByPlate', '— not used by this plate')}`;
                  return (
                    <BundleStringDropdown
                      key={`bundle-filament-${idx}`}
                      label={label}
                      options={selectedBundle.filament}
                      value={bundleFilamentNames[idx] ?? null}
                      onChange={(name) =>
                        setBundleFilamentNames((current) => {
                          const next = current.length === filamentSlots.length
                            ? [...current]
                            : filamentSlots.map((_, i) => current[i] ?? null);
                          next[idx] = name;
                          return next;
                        })
                      }
                      disabled={isEnqueuing || !isUsed}
                      swatchColor={filamentSlots.length > 1 ? slot.color : undefined}
                    />
                  );
                })
              ) : sourceIs3mf && filamentMode === 'embedded' ? (
                <div className="space-y-3">
                  <FilamentRequirementRows filaments={filamentSlots} />
                  <details className="rounded-md border border-bambu-dark-tertiary/50 bg-bambu-dark/30">
                    <summary className="cursor-pointer px-3 py-2 text-sm text-bambu-gray">
                      {t('slice.advanced', 'Advanced')}
                    </summary>
                    <div className="px-3 pb-3">
                      <button
                        type="button"
                        onClick={() => setFilamentMode('override')}
                        disabled={isEnqueuing}
                        className="text-sm text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                      >
                        {t('slice.overrideFilaments', 'Override filament profiles')}
                      </button>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="space-y-3">
                  {sourceIs3mf && (
                    <div className="rounded-md border border-bambu-dark-tertiary/50 bg-bambu-dark/30 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-bambu-gray">
                          {t('slice.advanced', 'Advanced')}
                        </span>
                        <button
                          type="button"
                          onClick={() => setFilamentMode('embedded')}
                          disabled={isEnqueuing}
                          className="text-sm text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                        >
                          {t('slice.useEmbeddedFilaments', 'Use 3MF filament profiles')}
                        </button>
                      </div>
                    </div>
                  )}
                  {filamentSlots.map((slot, idx) => {
                    // Slots flagged by the backend as not used by the
                    // picked plate are auto-picked from project metadata
                    // and disabled — the slicer CLI still needs a
                    // profile per project slot, but the user shouldn't
                    // have to think about slots their plate doesn't
                    // paint with. used_in_plate defaults to true when
                    // missing (sliced 3MFs and the no-flag legacy path).
                    const isUsed = slot.used_in_plate !== false;
                    const baseLabel =
                      filamentSlots.length > 1
                        ? t('slice.filamentSlot', {
                            index: idx + 1,
                            type: slot.type,
                            defaultValue: `Filament ${idx + 1} (${slot.type || ''})`,
                          })
                        : t('slice.filament', 'Filament profile');
                    const label = isUsed
                      ? baseLabel
                      : `${baseLabel} ${t('slice.notUsedByPlate', '— not used by this plate')}`;
                    return (
                      <PresetDropdown
                        key={`filament-${idx}`}
                        label={label}
                        slot="filament"
                        data={presetsQuery.data}
                        value={filamentPresets[idx] ?? null}
                        onChange={(ref) =>
                          setFilamentPresets((current) => {
                            const next = current.length === filamentSlots.length
                              ? [...current]
                              : filamentSlots.map((_, i) => current[i] ?? null);
                            next[idx] = ref;
                            return next;
                          })
                        }
                        disabled={isEnqueuing || !isUsed}
                        swatchColor={filamentSlots.length > 1 ? slot.color : undefined}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}

          {printerMismatch && (
            <div
              className="text-sm text-amber-200 bg-amber-900/20 border border-amber-700/40 rounded p-2"
              role="alert"
            >
              {t('slice.printerMismatch', {
                source: sourcePrinterModel ?? sourceDeviceKind,
                target: printerProfileName ?? targetDeviceKind,
                defaultValue:
                  'This 3MF was prepared for {{source}}, but you picked {{target}}. Bambuddy will ask the slicer to convert it with the selected profiles; if slicing fails, choose a matching device/profile.',
              })}
            </div>
          )}

          {errorMessage && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-900/40 rounded p-2" role="alert">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-bambu-dark-tertiary/40">
          <button
            type="button"
            onClick={onClose}
            disabled={isEnqueuing}
            className="px-3 py-1.5 text-sm rounded-md border border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-gray transition-colors disabled:opacity-50"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              setErrorMessage(null);
              enqueueMutation.mutate();
            }}
            disabled={!isReady || isEnqueuing}
            className="px-3 py-1.5 text-sm rounded-md bg-bambu-green hover:bg-bambu-green/90 text-bambu-dark font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isEnqueuing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('slice.enqueuing', 'Submitting slice job…')}
              </>
            ) : (
              t('slice.action', 'Slice')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilamentRequirementRows({ filaments }: { filaments: PlateFilament[] }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="text-sm text-bambu-gray mb-2">
        {t('slice.embeddedFilaments', '3MF filament profiles')}
      </div>
      <div className="space-y-2">
        {filaments.map((slot, idx) => {
          const isUsed = slot.used_in_plate !== false;
          const profile = slot.profile_name || slot.tray_info_idx || t('slice.embeddedFilamentProfile', 'Embedded profile');
          return (
            <div
              key={`${slot.slot_id}-${idx}`}
              className={`flex items-center gap-3 rounded-md border border-bambu-dark-tertiary/50 bg-bambu-dark/40 px-3 py-2 ${
                isUsed ? '' : 'opacity-60'
              }`}
            >
              <span
                className="w-4 h-4 rounded-full border border-bambu-dark-tertiary flex-shrink-0"
                style={{ backgroundColor: cssFilamentColor(slot.color) }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate">
                  {t('slice.filamentSlot', {
                    index: slot.slot_id || idx + 1,
                    type: slot.type,
                    defaultValue: `Filament ${slot.slot_id || idx + 1} (${slot.type || ''})`,
                  })}
                </div>
                <div className="text-xs text-bambu-gray truncate">
                  {profile}
                  {!isUsed ? ` ${t('slice.notUsedByPlate', '— not used by this plate')}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CloudStatusBanner({ status }: { status: SlicerCloudStatus }) {
  const { t } = useTranslation();
  if (status === 'ok') return null;

  // Map each non-ok status to the appropriate icon + tone. None of these are
  // hard errors — the user can still slice using local + standard presets,
  // so we use info / warn styling rather than error red.
  const config: Record<Exclude<SlicerCloudStatus, 'ok'>, { tone: string; icon: typeof Cloud; key: string; fallback: string }> = {
    not_authenticated: {
      tone: 'border-bambu-dark-tertiary/40 bg-bambu-dark text-bambu-gray',
      icon: Cloud,
      key: 'slice.cloud.notAuthenticated',
      fallback: 'Sign in to Bambu Cloud (Settings → Profiles → Cloud) to see your cloud presets.',
    },
    expired: {
      tone: 'border-amber-700/40 bg-amber-900/20 text-amber-200',
      icon: CloudOff,
      key: 'slice.cloud.expired',
      fallback: 'Bambu Cloud session expired — sign in again to refresh your cloud presets.',
    },
    unreachable: {
      tone: 'border-bambu-dark-tertiary/40 bg-bambu-dark text-bambu-gray',
      icon: CloudOff,
      key: 'slice.cloud.unreachable',
      fallback: 'Bambu Cloud is unreachable right now. Local and standard presets still work.',
    },
  };
  const { tone, icon: Icon, key, fallback } = config[status];
  return (
    <div className={`flex items-start gap-2 text-xs rounded-md border p-2 ${tone}`} role="status">
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{t(key, fallback)}</span>
    </div>
  );
}

interface PresetDropdownProps {
  label: string;
  slot: Slot;
  data: UnifiedPresetsResponse;
  value: PresetRef | null;
  onChange: (ref: PresetRef | null) => void;
  disabled?: boolean;
  // Optional colour swatch shown next to the label — used for multi-color
  // filament slots so the user can see at a glance which slot they're
  // configuring against the source 3MF's per-slot colour.
  swatchColor?: string;
}

function PresetDropdown({ label, slot, data, value, onChange, disabled, swatchColor }: PresetDropdownProps) {
  const { t } = useTranslation();

  const sections: { tierLabel: string; entries: UnifiedPreset[] }[] = useMemo(() => {
    // Order matches SLICE_MODAL_TIER_ORDER: imported first, then cloud, then
    // standard fallback. Sections with no entries collapse out so a user
    // without cloud / local presets only sees the tiers they actually have.
    const tiers: { key: keyof UnifiedPresetsResponse; tier: 'cloud' | 'local' | 'standard'; label: string; fallback: string }[] = [
      { key: 'local', tier: 'local', label: 'slice.tier.local', fallback: 'Imported' },
      { key: 'cloud', tier: 'cloud', label: 'slice.tier.cloud', fallback: 'Cloud' },
      { key: 'standard', tier: 'standard', label: 'slice.tier.standard', fallback: 'Standard' },
    ];
    return tiers
      .map(({ key, label: lk, fallback }) => ({
        tierLabel: t(lk, fallback),
        entries: (data[key] as UnifiedPresetsBySlot)[slot],
      }))
      .filter((s) => s.entries.length > 0);
  }, [data, slot, t]);

  const totalEntries = sections.reduce((sum, s) => sum + s.entries.length, 0);

  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs text-bambu-gray mb-1">
        {swatchColor && (
          <span
            className="inline-block w-3 h-3 rounded-full border border-bambu-dark-tertiary"
            style={{ backgroundColor: cssFilamentColor(swatchColor) }}
            aria-hidden
          />
        )}
        <span>{label}</span>
      </span>
      <select
        value={toRefValue(value)}
        onChange={(e) => onChange(fromRefValue(e.target.value))}
        disabled={disabled || totalEntries === 0}
        className="w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-gray disabled:opacity-50"
      >
        <option value="">
          {totalEntries === 0
            ? t('slice.noPresetsForSlot', 'No presets available')
            : t('slice.selectPreset', '— Select a preset —')}
        </option>
        {sections.map((section) => (
          <optgroup key={section.tierLabel} label={section.tierLabel}>
            {section.entries.map((p) => (
              <option key={`${p.source}:${p.id}`} value={`${p.source}:${p.id}`}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

// Top-of-modal bundle picker. The "None" option leaves the user on the
// cloud/local/standard tier path; selecting a bundle id flips the modal
// into bundle dispatch mode (see SliceModal state above).
interface BundlePickerProps {
  bundles: SlicerBundle[];
  selectedId: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}

function BundlePicker({ bundles, selectedId, onChange, disabled }: BundlePickerProps) {
  const { t } = useTranslation();
  return (
    <label className="block">
      <span className="block text-sm text-bambu-gray mb-1 inline-flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5" />
        {t('slice.bundle', 'Slicer bundle')}
      </span>
      <select
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        className="w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-gray disabled:opacity-50"
      >
        <option value="">
          {t('slice.bundleNone', '— None (pick presets individually) —')}
        </option>
        {bundles.map((b) => (
          <option key={b.id} value={b.id}>
            {b.printer_preset_name}
          </option>
        ))}
      </select>
    </label>
  );
}

// Plain-string dropdown used for bundle-mode process / filament selectors.
// Bundles store presets as a flat list of names within their printer-tied
// directory, so a `<select>` of strings is enough — no source tier, no
// optgroups. Same swatch / disabled affordances as the cloud/local/standard
// PresetDropdown above so the visual rhythm of the form stays consistent.
interface BundleStringDropdownProps {
  label: string;
  options: string[];
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  swatchColor?: string;
}

function BundleStringDropdown({
  label,
  options,
  value,
  onChange,
  disabled,
  swatchColor,
}: BundleStringDropdownProps) {
  const { t } = useTranslation();
  return (
    <label className="block">
      <span className="block text-sm text-bambu-gray mb-1 inline-flex items-center gap-1.5">
        {swatchColor && (
          <span
            className="inline-block w-3 h-3 rounded-sm border border-black/20"
            style={{ backgroundColor: cssFilamentColor(swatchColor) }}
            aria-hidden
          />
        )}
        <span>{label}</span>
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled || options.length === 0}
        className="w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-gray disabled:opacity-50"
      >
        <option value="">
          {options.length === 0
            ? t('slice.noPresetsForSlot', 'No presets available')
            : t('slice.selectPreset', '— Select a preset —')}
        </option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
