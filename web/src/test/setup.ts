// Vitest setup: mock wagmi + React hooks so pure-logic tests (useVaultData,
// useGuardianData) can call hooks directly without a React/wagmi context.
// The mocks return the "no data yet" shape so the fixture fallback path runs.
import { vi } from "vitest";

vi.mock("wagmi", () => ({
  useReadContracts:       () => ({ data: undefined }),
  useReadContract:        () => ({ data: undefined }),
  useWatchContractEvent:  () => undefined,
  useWriteContract:       () => ({ writeContract: vi.fn(), status: "idle", error: null }),
  useWaitForTransactionReceipt: () => ({ status: "idle", isLoading: false }),
  useAccount:             () => ({ address: undefined, isConnected: false }),
  useChainId:             () => 5000,
}));

// Stub React hooks used in seam hooks so they work outside a component tree.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();  // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...actual,
    useState: <T>(init: T | (() => T)) => {
      const v = typeof init === "function" ? (init as () => T)() : init;
      return [v, vi.fn()] as [T, ReturnType<typeof vi.fn>];
    },
    useRef: <T>(init: T) => ({ current: init }),
    useEffect: vi.fn(),
  };
});
