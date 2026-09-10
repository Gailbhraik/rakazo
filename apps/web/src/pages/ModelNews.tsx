import { useState } from "react";
import { Link } from "react-router-dom";
import { RecentModels } from "../components/RecentModels";
export function ModelNewsPage() {
  const [revision, setRevision] = useState(0);
  return (
    <div className="rk-home h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-5 pb-12 pt-8 sm:px-8">
        <header className="mb-6 flex items-center justify-between gap-4">
          <Link to="/home" className="rounded-lg py-2 text-sm text-[var(--rk-accent)]">
            ← Accueil
          </Link>
          <button
            type="button"
            className="rk-home-refresh text-sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            Actualiser
          </button>
        </header>
        <RecentModels revision={revision} />
      </main>
    </div>
  );
}
