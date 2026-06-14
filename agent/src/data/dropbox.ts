/**
 * Minimal Dropbox client for reading a PUBLIC shared folder via the API: mint a
 * short-lived access token from a long-lived OAuth refresh token, list a shared
 * link's contents, and download a file from it. Only what the attestation-evidence
 * path needs (data/attestations.ts) — no SDK.
 *
 * Auth: a Scoped app with `files.metadata.read` + `sharing.read`. The token is only
 * needed to LIST (discover the latest file); the access token is cached until shortly
 * before it expires so routine cycles don't re-mint.
 */

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

export interface DropboxEntry {
  /** Dropbox tags the entry type via the JSON `.tag` discriminator. */
  readonly tag: "file" | "folder";
  readonly name: string;
}

export interface DropboxClientConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** The subset of {@link DropboxClient} the attestation reader depends on (for tests). */
export interface DropboxReader {
  listSharedFolder(sharedLinkUrl: string, path: string): Promise<DropboxEntry[]>;
  downloadSharedFile(sharedLinkUrl: string, path: string): Promise<Uint8Array>;
}

const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const LIST_URL = "https://api.dropboxapi.com/2/files/list_folder";
const DOWNLOAD_URL = "https://content.dropboxapi.com/2/sharing/get_shared_link_file";

export class DropboxClient implements DropboxReader {
  private readonly cfg: DropboxClientConfig;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private cached?: { token: string; expiresAt: number };

  constructor(cfg: DropboxClientConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  /** Mint (and cache) an access token from the refresh token. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.token;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.appKey,
      client_secret: this.cfg.appSecret,
    }).toString();

    const json = (await this.request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    })) as { access_token?: string; expires_in?: number };

    if (!json.access_token) throw new Error("Dropbox token mint returned no access_token");
    // Refresh ~60s early so an in-flight call never uses a just-expired token.
    const ttlMs = Math.max(0, (json.expires_in ?? 14_400) - 60) * 1000;
    this.cached = { token: json.access_token, expiresAt: now + ttlMs };
    return json.access_token;
  }

  async listSharedFolder(sharedLinkUrl: string, path: string): Promise<DropboxEntry[]> {
    const token = await this.accessToken();
    const json = (await this.request(LIST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path, shared_link: { url: sharedLinkUrl } }),
    })) as { entries?: { [k: string]: unknown; ".tag"?: string; name?: string }[] };

    return (json.entries ?? [])
      .filter((e): e is { ".tag": "file" | "folder"; name: string } =>
        (e[".tag"] === "file" || e[".tag"] === "folder") && typeof e.name === "string",
      )
      .map((e) => ({ tag: e[".tag"], name: e.name }));
  }

  async downloadSharedFile(sharedLinkUrl: string, path: string): Promise<Uint8Array> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(DOWNLOAD_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        // Binary endpoint: args ride a header, not the body.
        "Dropbox-API-Arg": JSON.stringify({ url: sharedLinkUrl, path }),
      },
      signal: this.signal(),
    });
    if (!res.ok) {
      throw new Error(`Dropbox download failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** POST + JSON parse with a timeout and a body-bearing error on non-2xx. */
  private async request(url: string, init: Parameters<FetchLike>[1]): Promise<unknown> {
    const res = await this.fetchImpl(url, { ...init, signal: this.signal() });
    if (!res.ok) {
      throw new Error(`Dropbox ${url} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }
}
