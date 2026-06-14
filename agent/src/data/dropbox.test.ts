import { describe, it, expect, vi } from "vitest";
import { DropboxClient, type FetchLike } from "./dropbox.js";

function res(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const CFG = { appKey: "k", appSecret: "s", refreshToken: "rt" };

describe("DropboxClient", () => {
  it("mints an access token from the refresh token, then lists with a bearer header", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      if (url.includes("oauth2/token")) return res({ access_token: "AT", expires_in: 14_400 });
      return res({ entries: [{ ".tag": "folder", name: "2026" }, { ".tag": "file", name: "x.pdf" }] });
    });
    const client = new DropboxClient({ ...CFG, fetchImpl });

    const entries = await client.listSharedFolder("https://dropbox/folder", "");
    expect(entries).toEqual([{ tag: "folder", name: "2026" }, { tag: "file", name: "x.pdf" }]);

    // Token mint sends the refresh-token grant.
    const tokenCall = fetchImpl.mock.calls.find(([u]) => u.includes("oauth2/token"))!;
    expect(tokenCall[1].body).toContain("grant_type=refresh_token");
    // List call carries the minted bearer + the shared_link arg.
    const listCall = fetchImpl.mock.calls.find(([u]) => u.includes("list_folder"))!;
    expect(listCall[1].headers.authorization).toBe("Bearer AT");
    expect(JSON.parse(listCall[1].body!)).toEqual({ path: "", shared_link: { url: "https://dropbox/folder" } });
  });

  it("caches the access token across calls (one mint for many requests)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("oauth2/token") ? res({ access_token: "AT", expires_in: 14_400 }) : res({ entries: [] }),
    );
    const client = new DropboxClient({ ...CFG, fetchImpl });

    await client.listSharedFolder("u", "");
    await client.listSharedFolder("u", "/2026");

    const mints = fetchImpl.mock.calls.filter(([u]) => u.includes("oauth2/token"));
    expect(mints).toHaveLength(1);
  });

  it("surfaces a download failure with status + body", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes("oauth2/token") ? res({ access_token: "AT", expires_in: 14_400 }) : res("not found", false, 409),
    );
    const client = new DropboxClient({ ...CFG, fetchImpl });
    await expect(client.downloadSharedFile("u", "/missing.pdf")).rejects.toThrow(/409/);
  });
});
