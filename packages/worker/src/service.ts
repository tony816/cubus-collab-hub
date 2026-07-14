import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type ProposePatchInput,
  type ProposalStatus,
  type UpsertDocumentInput,
  toCamelDocument,
} from "@cubus/shared";
import type { AppEnv } from "./env.js";
import type { Database } from "./database.types.js";
import { sha256Hex } from "./security.js";

type JsonObject = Record<string, unknown>;

function requireData<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Supabase returned no data");
  return data;
}

export class CollabService {
  readonly db: SupabaseClient<Database>;

  constructor(env: AppEnv) {
    const proxyFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const target = new URL(request.url);
      if (target.origin !== new URL(env.SUPABASE_URL).origin || !target.pathname.startsWith("/rest/v1/")) {
        throw new Error("Supabase proxy rejected an unexpected target");
      }

      const forwardedHeaders: Record<string, string> = {};
      for (const name of ["accept", "accept-profile", "content-profile", "content-type", "prefer", "range", "range-unit"]) {
        const value = request.headers.get(name);
        if (value) forwardedHeaders[name] = value;
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      return fetch(env.SUPABASE_PROXY_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cubus-proxy-secret": env.SUPABASE_PROXY_SECRET,
        },
        body: JSON.stringify({
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: forwardedHeaders,
          body,
        }),
      });
    };

    this.db = createClient<Database>(env.SUPABASE_URL, "proxy-transport", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: { "X-Client-Info": "cubus-collab-worker/0.1" },
        fetch: proxyFetch,
      },
    });
  }

  async getDocument(path: string): Promise<ReturnType<typeof toCamelDocument>> {
    const { data, error } = await this.db.from("documents").select("*").eq("path", path).eq("deleted", false).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Document not found: ${path}`);
    return toCamelDocument(data);
  }

  async search(query: string, limit: number): Promise<ReturnType<typeof toCamelDocument>[]> {
    const { data, error } = await this.db.rpc("search_canonical_documents", {
      p_query: query,
      p_limit: limit,
    });
    return requireData(data, error).map((row) => toCamelDocument(row));
  }

  async syncContext(input: {
    agent: "chatgpt" | "claude";
    query: string;
    focusPaths: string[];
    maxChars: number;
  }): Promise<JsonObject> {
    const cursorResult = await this.db.from("agent_cursors").select("last_sequence").eq("agent", input.agent).maybeSingle();
    if (cursorResult.error) throw new Error(cursorResult.error.message);
    const cursor = cursorResult.data?.last_sequence ?? 0;

    const [eventsResult, proposalsResult, conflictsResult, focused, searched] = await Promise.all([
      this.db.from("events").select("sequence,kind,entity_type,entity_id,actor,origin,metadata,created_at")
        .gt("sequence", cursor).order("sequence", { ascending: true }).limit(200),
      this.db.from("proposals").select("id,target_path,base_version,rationale,agent,status,created_at")
        .eq("status", "pending").order("created_at", { ascending: true }).limit(50),
      this.db.from("conflicts").select("id,path,expected_version,actual_version,origin,status,created_at")
        .eq("status", "open").order("created_at", { ascending: true }).limit(50),
      Promise.all(input.focusPaths.map(async (path) => this.getDocument(path).catch(() => null))),
      input.query.length > 0 ? this.search(input.query, 10) : Promise.resolve([]),
    ]);

    if (eventsResult.error) throw new Error(eventsResult.error.message);
    if (proposalsResult.error) throw new Error(proposalsResult.error.message);
    if (conflictsResult.error) throw new Error(conflictsResult.error.message);

    const latestSequence = eventsResult.data.reduce((max, event) => Math.max(max, event.sequence), cursor);
    const candidates = [...focused.filter((doc) => doc !== null), ...searched];
    const unique = new Map(candidates.map((doc) => [doc.path, doc]));
    let remaining = input.maxChars;
    const documents = [];
    for (const document of unique.values()) {
      if (remaining <= 0) break;
      const content = document.content.slice(0, remaining);
      documents.push({ ...document, content, truncated: content.length < document.content.length });
      remaining -= content.length;
    }

    return {
      cursor,
      latestSequence,
      changes: eventsResult.data,
      documents,
      pendingProposals: proposalsResult.data,
      openConflicts: conflictsResult.data,
    };
  }

  async listProposals(status?: ProposalStatus): Promise<unknown[]> {
    let query = this.db.from("proposals").select("id,target_path,base_version,rationale,agent,status,resolution_note,created_at,resolved_at")
      .order("created_at", { ascending: false }).limit(100);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    return requireData(data, error);
  }

  async propose(input: ProposePatchInput): Promise<JsonObject> {
    const sha = await sha256Hex(input.proposedContent);
    const byteCount = new TextEncoder().encode(input.proposedContent).byteLength;
    const { data, error } = await this.db.rpc("create_document_proposal", {
      p_target_path: input.targetPath,
      p_expected_version: input.expectedVersion,
      p_proposed_content: input.proposedContent,
      p_proposed_frontmatter: input.proposedFrontmatter,
      p_proposed_sha256: sha,
      p_proposed_byte_count: byteCount,
      p_rationale: input.rationale,
      p_agent: input.agent,
    });
    return requireData(data as JsonObject | null, error);
  }

  async approve(proposalId: string, instruction: string): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("approve_document_proposal", {
      p_proposal_id: proposalId,
      p_instruction: instruction,
    });
    return requireData(data as JsonObject | null, error);
  }

  async reject(proposalId: string, instruction: string, reason: string): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("reject_document_proposal", {
      p_proposal_id: proposalId,
      p_instruction: instruction,
      p_reason: reason,
    });
    return requireData(data as JsonObject | null, error);
  }

  async recordTurn(input: {
    agent: "chatgpt" | "claude";
    seenSequence: number;
    summary: string;
    affectedPaths: string[];
  }): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("record_agent_turn", {
      p_agent: input.agent,
      p_seen_sequence: input.seenSequence,
      p_summary: input.summary,
      p_affected_paths: input.affectedPaths,
    });
    return requireData(data as JsonObject | null, error);
  }

  async upsertDocument(input: UpsertDocumentInput): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("upsert_canonical_document", {
      p_path: input.path,
      p_title: input.title,
      p_content: input.content,
      p_frontmatter: input.frontmatter,
      p_sha256: input.sha256,
      p_byte_count: input.byteCount,
      p_expected_version: input.expectedVersion,
      p_origin: input.origin,
      p_actor: "bridge",
    });
    return requireData(data as JsonObject | null, error);
  }

  async upsertDocuments(inputs: UpsertDocumentInput[]): Promise<JsonObject[]> {
    const { data, error } = await this.db.rpc("upsert_canonical_documents_batch", {
      p_documents: inputs,
    });
    return requireData(data as JsonObject[] | null, error);
  }

  async renameDocument(oldPath: string, newPath: string, expectedVersion: number): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("rename_canonical_document", {
      p_old_path: oldPath,
      p_new_path: newPath,
      p_expected_version: expectedVersion,
    });
    return requireData(data as JsonObject | null, error);
  }

  async deleteDocument(path: string, expectedVersion: number): Promise<JsonObject> {
    const { data, error } = await this.db.rpc("delete_canonical_document", {
      p_path: path,
      p_expected_version: expectedVersion,
    });
    return requireData(data as JsonObject | null, error);
  }

  async manifest(): Promise<unknown[]> {
    const documents: unknown[] = [];
    const pageSize = 1000;
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await this.db.from("documents")
        .select("path,sha256,byte_count,version,updated_at")
        .eq("deleted", false)
        .order("path", { ascending: true })
        .range(start, start + pageSize - 1);
      const page = requireData(data, error);
      documents.push(...page);
      if (page.length < pageSize) break;
    }
    return documents;
  }

  async eventsAfter(sequence: number): Promise<unknown[]> {
    const { data, error } = await this.db.from("events")
      .select("sequence,kind,entity_type,entity_id,actor,origin,metadata,created_at")
      .gt("sequence", sequence).order("sequence", { ascending: true }).limit(500);
    return requireData(data, error);
  }

  async getConflict(id: string): Promise<unknown> {
    const { data, error } = await this.db.from("conflicts").select("*").eq("id", id).single();
    return requireData(data, error);
  }
}
