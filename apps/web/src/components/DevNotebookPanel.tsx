import { useState } from "react";
import {
  type DevItem,
  type DevNotebook,
  notebookMarkdown,
  parseNotebook,
} from "../lib/dev-notebook";
import { BuiButton, BuiCard } from "./beautiful-ui/primitives";

const field = "w-full rounded-lg border border-[var(--rk-n77)] bg-transparent p-2 text-sm";
export function DevNotebookPanel({ storageKey }: { storageKey: string }) {
  const [initial] = useState(() => {
    try {
      return { data: parseNotebook(localStorage.getItem(storageKey)), error: "" };
    } catch {
      return {
        data: { notes: "", items: [] } as DevNotebook,
        error: "Impossible de charger le carnet. Les données existantes sont conservées.",
      };
    }
  });
  const [data, setData] = useState(initial.data);
  const [notice, setNotice] = useState(initial.error);
  const [kind, setKind] = useState<DevItem["kind"]>("task");
  const [priority, setPriority] = useState<DevItem["priority"]>("normal");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [removed, setRemoved] = useState<DevItem | null>(null);
  function save(next: DevNotebook) {
    if (initial.error) return;
    setData(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setNotice("Enregistré sur cet appareil");
    } catch {
      setNotice("Échec de sauvegarde locale : exporte le carnet avant de fermer.");
    }
  }
  function download(format: "md" | "json") {
    const url = URL.createObjectURL(
      new Blob([format === "md" ? notebookMarkdown(data) : JSON.stringify(data, null, 2)], {
        type: format === "md" ? "text/markdown;charset=utf-8" : "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `carnet-dev.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const visible = data.items.filter(
    (item) =>
      (!openOnly || !item.done) &&
      item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const bugs = data.items.filter((item) => item.kind === "bug" && !item.done).length;
  return (
    <BuiCard
      className="mx-3 my-2 max-h-[55vh] overflow-y-auto p-4 text-[var(--rk-n08)]"
      role="region"
      aria-label="Carnet de développement"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>Carnet de développement</strong>
        <span className="text-xs">
          {data.items.filter((item) => item.kind === "task" && !item.done).length} tâches · {bugs}{" "}
          bugs ouverts
        </span>
      </div>
      <p className="my-2 text-xs text-[var(--rk-n29)]">
        Carnet privé à ce navigateur et à ce bot. Les notes ne sont pas envoyées au bot.
      </p>
      <fieldset disabled={Boolean(initial.error)} className="space-y-3">
        <label className="block text-sm">
          Notes du projet
          <textarea
            aria-label="Notes du projet"
            className={`${field} mt-1`}
            rows={3}
            value={data.notes}
            onChange={(event) => save({ ...data, notes: event.target.value })}
            placeholder="Objectif, dépôt, étapes de lancement…"
          />
        </label>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) return;
            save({
              ...data,
              items: [
                ...data.items,
                { id: crypto.randomUUID(), kind, priority, text: text.trim(), done: false },
              ],
            });
            setText("");
          }}
        >
          <select
            aria-label="Type d’entrée"
            className={`${field} !w-auto`}
            value={kind}
            onChange={(event) => setKind(event.target.value as DevItem["kind"])}
          >
            <option value="task">Tâche</option>
            <option value="bug">Bug</option>
            <option value="command">Commande</option>
          </select>
          <select
            aria-label="Priorité"
            className={`${field} !w-auto`}
            value={priority}
            onChange={(event) => setPriority(event.target.value as DevItem["priority"])}
          >
            <option value="normal">Normale</option>
            <option value="high">Prioritaire</option>
          </select>
          <input
            aria-label="Nouvelle entrée"
            className={`${field} min-w-40 flex-1`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Tâche, erreur à corriger ou commande…"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="rounded-lg border border-[var(--rk-n77)] px-3 disabled:opacity-50"
          >
            Ajouter
          </button>
        </form>
        <div className="flex items-center gap-3">
          <input
            aria-label="Filtrer le carnet"
            className={field}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Rechercher dans le carnet…"
          />
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(event) => setOpenOnly(event.target.checked)}
            />
            À traiter
          </label>
        </div>
        <ul className="space-y-2">
          {visible.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-2 rounded-lg border border-[var(--rk-n89)] p-2 text-sm"
            >
              {item.kind !== "command" && (
                <input
                  aria-label={`Terminer : ${item.text}`}
                  type="checkbox"
                  checked={item.done}
                  onChange={() =>
                    save({
                      ...data,
                      items: data.items.map((row) =>
                        row.id === item.id ? { ...row, done: !row.done } : row,
                      ),
                    })
                  }
                  className="mt-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <span className="text-xs text-[var(--rk-n29)]">
                  {item.kind === "bug" ? "Bug" : item.kind === "command" ? "Commande" : "Tâche"}
                  {item.priority === "high" ? " · Prioritaire" : ""}
                </span>
                <p
                  className={`whitespace-pre-wrap break-words ${item.done ? "line-through opacity-60" : ""} ${item.kind === "command" ? "font-mono" : ""}`}
                >
                  {item.text}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Copier : ${item.text}`}
                onClick={() => {
                  void navigator.clipboard.writeText(item.text).then(
                    () => setNotice("Copié"),
                    () => setNotice("Copie impossible dans ce navigateur"),
                  );
                }}
              >
                Copier
              </button>
              <button
                type="button"
                aria-label={`Supprimer : ${item.text}`}
                onClick={() => {
                  setRemoved(item);
                  save({ ...data, items: data.items.filter((row) => row.id !== item.id) });
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {visible.length === 0 && <p className="text-sm text-[var(--rk-n29)]">Aucune entrée.</p>}
        {removed && (
          <BuiButton
            onClick={() => {
              save({ ...data, items: [...data.items, removed] });
              setRemoved(null);
            }}
          >
            Annuler la suppression
          </BuiButton>
        )}
      </fieldset>
      <div className="mt-3 flex flex-wrap gap-2">
        <BuiButton onClick={() => download("md")}>Exporter Markdown</BuiButton>
        <BuiButton onClick={() => download("json")}>Sauvegarder JSON</BuiButton>
      </div>
      <p role="status" className="mt-2 text-xs">
        {notice}
      </p>
    </BuiCard>
  );
}
