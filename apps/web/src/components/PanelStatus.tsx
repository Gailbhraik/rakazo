import { useLingui } from "@lingui/react/macro";

/**
 * L'état de l'ordinateur d'un bot, en en-tête du panneau latéral.
 *
 * Il s'affichait en texte brut minuscule, tel que le renvoie l'API
 * (« running », « booting »). Un mot nu ne dit ni qu'il s'agit d'un état, ni
 * s'il est normal ou fautif : la pastille colorée porte cette information
 * avant la lecture, et le libellé traduit la rend explicite.
 */

const TONES = {
  live: { dot: "bg-[#4ADE80]", text: "text-[#CFC9C8]", pulse: true },
  pending: { dot: "bg-[#E5A83A]", text: "text-[#CFC9C8]", pulse: true },
  idle: { dot: "bg-[#7B6561]", text: "text-[#967E79]", pulse: false },
  fault: { dot: "bg-[#EF4444]", text: "text-[#F3A2AA]", pulse: false },
} as const;

type Tone = keyof typeof TONES;

export function PanelStatus({ state, compact = false }: { state: string; compact?: boolean }) {
  const { t } = useLingui();

  const known: Record<string, { label: string; tone: Tone }> = {
    running: { label: t`Running`, tone: "live" },
    booting: { label: t`Starting`, tone: "pending" },
    suspended: { label: t`Suspended`, tone: "idle" },
    stopped: { label: t`Stopped`, tone: "idle" },
    error: { label: t`Error`, tone: "fault" },
  };

  // Le statut d'un bot est une chaîne libre côté contrat : on capitalise ce qui
  // arrive plutôt que de masquer un état qu'on ne connaîtrait pas encore.
  const entry = known[state] ?? {
    label: state.charAt(0).toUpperCase() + state.slice(1),
    tone: "idle" as Tone,
  };
  const tone = TONES[entry.tone];

  const dot = (
    <span className="relative grid h-2 w-2 place-items-center">
      {tone.pulse ? (
        <span className={`absolute h-2 w-2 animate-ping rounded-full ${tone.dot} opacity-60`} />
      ) : null}
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
    </span>
  );

  // Dans une ligne de liste, la place manque et le nom du bot prime : la
  // pastille seule suffit, le libellé reste accessible au lecteur d'écran.
  if (compact) {
    return (
      <span className="flex items-center" title={entry.label}>
        {dot}
        <span className="sr-only">{entry.label}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      {dot}
      <span className={`text-[13.5px] ${tone.text}`}>{entry.label}</span>
    </span>
  );
}
