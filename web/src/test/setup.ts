// Vitest setup: mock wagmi + React hooks so pure-logic tests (useVaultData,
// useGuardianData) can call hooks directly without a React/wagmi context.
// The mocks return the "no data yet" shape so the fixture fallback path runs.
import { vi } from "vitest";

vi.mock("wagmi", () => ({
  useReadContracts:       () => ({ data: undefined }),
  useReadContract:        () => ({ data: undefined }),
  useWatchContractEvent:  () => undefined,
  usePublicClient:        () => undefined,
  useWriteContract:       () => ({ writeContractAsync: vi.fn(), writeContract: vi.fn(), status: "idle", error: null }),
  useWaitForTransactionReceipt: () => ({ status: "idle", isLoading: false, isSuccess: false }),
  useAccount:             () => ({ address: undefined, isConnected: false }),
  useChainId:             () => 5000,
}));

// Stub React hooks so seam hooks work outside a component tree.
// importOriginal is typed as Record<string, unknown> to avoid the
// @typescript-eslint/consistent-type-imports restriction on import() in type positions.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
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
