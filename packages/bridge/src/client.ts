import type { CanonicalDocument, UpsertDocumentInput } from "@cubus/shared";

export type ManifestRow = {
  path: string;
  sha256: string;
  byte_count: number;
  version: number;
  updated_at: string;
};

export type HubEvent = {
  sequence: number;
  kind: string;
  entity_type: string;
  entity_id: string | null;
  actor: string;
  origin: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type UpsertResult = {
  status: "created" | "updated" | "unchanged" | "conflict" | "renamed" | "deleted";
  id?: string;
  version?: number;
  conflictId?: string;
  actualVersion?: number;
};

export class HubClient {
  constructor(private readonly apiUrl: string, private readonly token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Content-Type", "application/json");
    const response = await fetch(new URL(path, this.apiUrl), {
      ...init,
      headers,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Hub ${response.status}: ${text.slice(0, 1000)}`);
    return JSON.parse(text) as T;
  }

  async manifest(): Promise<ManifestRow[]> {
    return (await this.request<{ documents: ManifestRow[] }>("/api/bridge/manifest")).documents;
  }

  async upsert(document: UpsertDocumentInput): Promise<UpsertResult> {
    return this.request<UpsertResult>("/api/bridge/documents", { method: "POST", body: JSON.stringify(document) });
  }

  async upsertBatch(documents: UpsertDocumentInput[]): Promise<UpsertResult[]> {
    return (await this.request<{ results: UpsertResult[] }>("/api/bridge/documents/batch", {
      method: "POST",
      body: JSON.stringify({ documents }),
    })).results;
  }

  async document(path: string): Promise<CanonicalDocument> {
    return this.request<CanonicalDocument>(`/api/bridge/documents?path=${encodeURIComponent(path)}`);
  }

  async events(after: number): Promise<HubEvent[]> {
    return (await this.request<{ events: HubEvent[] }>(`/api/bridge/events?after=${after}`)).events;
  }

  async conflict(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/api/bridge/conflicts/${encodeURIComponent(id)}`);
  }

  async renameDocument(oldPath: string, newPath: string, expectedVersion: number): Promise<UpsertResult> {
    return this.request<UpsertResult>("/api/bridge/documents/rename", {
      method: "POST",
      body: JSON.stringify({ oldPath, newPath, expectedVersion }),
    });
  }

  async deleteDocument(path: string, expectedVersion: number): Promise<UpsertResult> {
    return this.request<UpsertResult>(`/api/bridge/documents?path=${encodeURIComponent(path)}&expectedVersion=${expectedVersion}`, {
      method: "DELETE",
    });
  }
}
