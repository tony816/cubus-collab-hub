export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type DocumentRow = {
  id: string;
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  sha256: string;
  byte_count: number;
  version: number;
  origin: "obsidian" | "approved_proposal" | "drive_import" | "system";
  deleted: boolean;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  sequence: number;
  kind: string;
  entity_type: string;
  entity_id: string | null;
  actor: "chatgpt" | "claude" | "bridge" | "user" | "system";
  origin: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type ProposalRow = {
  id: string;
  document_id: string;
  target_path: string;
  base_version: number;
  proposed_content: string;
  proposed_frontmatter: Record<string, unknown> | null;
  proposed_sha256: string;
  proposed_byte_count: number;
  rationale: string;
  agent: "chatgpt" | "claude";
  status: "pending" | "approved" | "rejected" | "conflict";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

type ConflictRow = {
  id: string;
  document_id: string | null;
  path: string;
  expected_version: number | null;
  actual_version: number | null;
  local_content: string;
  remote_content: string;
  origin: string;
  status: "open" | "resolved" | "dismissed";
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

type Table<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      documents: Table<DocumentRow>;
      document_versions: Table<Record<string, never>>;
      proposals: Table<ProposalRow>;
      events: Table<EventRow>;
      agent_cursors: Table<{ agent: "chatgpt" | "claude" | "bridge"; last_sequence: number; updated_at: string }>;
      turn_summaries: Table<Record<string, never>>;
      conflicts: Table<ConflictRow>;
    };
    Views: Record<string, never>;
    Functions: {
      search_canonical_documents: {
        Args: { p_query: string; p_limit: number };
        Returns: DocumentRow[];
      };
      create_document_proposal: {
        Args: {
          p_target_path: string;
          p_expected_version: number;
          p_proposed_content: string;
          p_proposed_frontmatter: Record<string, unknown> | null;
          p_proposed_sha256: string;
          p_proposed_byte_count: number;
          p_rationale: string;
          p_agent: string;
        };
        Returns: Json;
      };
      approve_document_proposal: { Args: { p_proposal_id: string; p_instruction: string }; Returns: Json };
      reject_document_proposal: { Args: { p_proposal_id: string; p_instruction: string; p_reason: string }; Returns: Json };
      record_agent_turn: {
        Args: { p_agent: string; p_seen_sequence: number; p_summary: string; p_affected_paths: string[] };
        Returns: Json;
      };
      upsert_canonical_document: {
        Args: {
          p_path: string;
          p_title: string;
          p_content: string;
          p_frontmatter: Record<string, unknown>;
          p_sha256: string;
          p_byte_count: number;
          p_expected_version: number | null;
          p_origin: string;
          p_actor: string;
        };
        Returns: Json;
      };
      upsert_canonical_documents_batch: { Args: { p_documents: unknown[] }; Returns: Json };
      rename_canonical_document: {
        Args: { p_old_path: string; p_new_path: string; p_expected_version: number };
        Returns: Json;
      };
      delete_canonical_document: { Args: { p_path: string; p_expected_version: number }; Returns: Json };
    };
    Enums: {
      document_origin: "obsidian" | "approved_proposal" | "drive_import" | "system";
      proposal_status: "pending" | "approved" | "rejected" | "conflict";
    };
    CompositeTypes: Record<string, never>;
  };
};

