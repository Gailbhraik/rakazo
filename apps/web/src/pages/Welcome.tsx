import { Trans } from "@lingui/react/macro";
import { useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="rk-welcome flex min-h-full flex-col bg-[var(--rk-n100)]">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-11 pb-[90px]">
        <div className="flex items-center gap-4 sm:gap-[26px]">
          <div className="flex h-[88px] w-[88px] items-center justify-center gap-[13px] rounded-full bg-[var(--rk-n05)]">
            <span className="h-6 w-[11px] rounded-full bg-[var(--rk-n93)]" />
            <span className="h-6 w-[11px] rounded-full bg-[var(--rk-n93)]" />
          </div>
          <div className="text-[44px] sm:text-[76px] leading-none tracking-[-0.03em] text-[var(--rk-ink)]">
            Ashitaka
          </div>
        </div>
        <p className="max-w-[600px] text-center px-6 text-[20px] sm:text-[27px] leading-[1.4] text-[var(--rk-n12)]">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <button
          type="button"
          onClick={() => navigate("/sign-in")}
          className="app-no-drag rounded-full bg-[var(--rk-a17)] px-[34px] py-[15px] text-[19px] text-white transition hover:scale-[1.04] hover:bg-[var(--rk-a13)]"
        >
          <Trans>Sign in&nbsp;&nbsp;→</Trans>
        </button>
      </div>
    </div>
  );
}
