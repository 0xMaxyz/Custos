import { MANTLE_MAINNET_CHAIN_ID } from "@sentinel/shared";

export default function App() {
  return (
    <main className="min-h-screen bg-base-200 text-base-content">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
        <header className="flex flex-col gap-2">
          <span className="badge badge-primary badge-outline w-fit">
            Mantle · chain {MANTLE_MAINNET_CHAIN_ID}
          </span>
          <h1 className="text-3xl font-bold">Sentinel</h1>
          <p className="text-base-content/70">
            AI risk-guardian real-yield account. Deposit USDC, earn tokenized-Treasury yield,
            and let the agent autonomously de-risk on-chain — verifiably.
          </p>
        </header>

        <div className="card bg-base-100 shadow">
          <div className="card-body">
            <h2 className="card-title">Scaffold ready</h2>
            <p className="text-base-content/70">
              UI shell wired with the Sentinel daisyUI theme. Dashboard, risk-guardian feed,
              and identity card come online in Phase 4.
            </p>
            <div className="card-actions">
              <button className="btn btn-primary" disabled>
                Connect wallet (Phase 4)
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
