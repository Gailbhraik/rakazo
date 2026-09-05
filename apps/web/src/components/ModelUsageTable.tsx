import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelUsage } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/**
 * Consommation détaillée par modèle.
 *
 * Le total seul ne dit pas où part l'argent : c'est la répartition qu'on vient
 * chercher, d'où le tri par volume décroissant.
 */

/** Les jetons se comptent par millions : les chiffres bruts ne se lisent pas. */
function formatTokens(value: number, locale: string): string {
  if (value >= 1_000_000)
    return (value / 1_000_000).toLocaleString(locale, { maximumFractionDigits: 2 }) + " M";
  if (value >= 1_000) return Math.round(value / 1_000).toLocaleString(locale) + " k";
  return value.toLocaleString(locale);
}

function formatCost(value: number, locale: string): string {
  // Sous le centime, arrondir afficherait « 0,00 $ » pour une dépense réelle.
  if (value > 0 && value < 0.01) return "< 0,01 $";
  return value.toLocaleString(locale, { style: "currency", currency: "USD" });
}

export function ModelUsageTable() {
  const { t, i18n } = useLingui();
  const locale = i18n.locale || "fr";
  const [rows, setRows] = useState<ModelUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void rpc.usage
      .byModel()
      .then((result) => {
        if (alive) setRows(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : t`Could not load usage`);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  if (error) {
    return (
      <p role="alert" className="mt-3 text-[12.5px] text-[#F3A2AA]">
        {error}
      </p>
    );
  }
  if (!rows) {
    return (
      <p className="mt-3 text-[12.5px] text-[#7B6561]">
        <Trans>Loading usage…</Trans>
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-[12.5px] text-[#7B6561]">
        <Trans>No model has run yet.</Trans>
      </p>
    );
  }

  const known = rows.filter((row) => row.estimatedCost !== null);
  const total = known.reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0);
  const partial = known.length < rows.length;

  return (
    <div className="mt-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-[13px]">
          <thead>
            <tr className="text-start text-[12px] text-[#7B6561]">
              <th className="pb-2 text-start font-normal">
                <Trans>Model</Trans>
              </th>
              <th className="pb-2 text-end font-normal">
                <Trans>Runs</Trans>
              </th>
              <th className="pb-2 text-end font-normal">
                <Trans>In</Trans>
              </th>
              <th className="pb-2 text-end font-normal">
                <Trans>Out</Trans>
              </th>
              <th className="pb-2 text-end font-normal">
                <Trans>Est. cost</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.provider}:${row.model}`} className="border-t border-[#231A18]">
                <td className="py-2 pe-3">
                  <span className="block max-w-[220px] truncate text-[#EEECEC]" title={row.model}>
                    {row.label}
                  </span>
                  <span className="block text-[11.5px] text-[#7B6561]">
                    {row.providerName ?? row.provider}
                    {" · "}
                    {new Date(row.lastUsedAt).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </td>
                <td className="py-2 text-end tabular-nums text-[#D0C8C7]">
                  {row.runs.toLocaleString(locale)}
                </td>
                <td className="py-2 text-end tabular-nums text-[#D0C8C7]">
                  {formatTokens(row.inputTokens, locale)}
                </td>
                <td className="py-2 text-end tabular-nums text-[#D0C8C7]">
                  {formatTokens(row.outputTokens, locale)}
                </td>
                <td className="py-2 text-end tabular-nums text-[#EEECEC]">
                  {row.estimatedCost === null ? (
                    <span className="text-[#7B6561]" title={t`This model is not in the catalog`}>
                      —
                    </span>
                  ) : (
                    formatCost(row.estimatedCost, locale)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12.5px] text-[#7B6561]">
        <Trans>Estimated total: {formatCost(total, locale)}</Trans>
        {". "}
        <Trans>
          Catalog prices, so caching discounts and negotiated rates are not reflected — this is an
          estimate, not your provider invoice.
        </Trans>
        {partial ? (
          <>
            {" "}
            <Trans>Models missing from the catalog are excluded from the total.</Trans>
          </>
        ) : null}
      </p>
    </div>
  );
}
