import { z } from "zod";

export const AgentSchema = z.enum(["chatgpt", "claude", "bridge", "user", "system"]);
export type Agent = z.infer<typeof AgentSchema>;

export const ProposalStatusSchema = z.enum(["pending", "approved", "rejected", "conflict"]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const DocumentOriginSchema = z.enum(["obsidian", "approved_proposal", "drive_import", "system"]);
export type DocumentOrigin = z.infer<typeof DocumentOriginSchema>;

export const DocumentSchema = z.object({
  id: z.uuid(),
  path: z.string().min(1),
  title: z.string(),
  content: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  origin: DocumentOriginSchema,
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CanonicalDocument = z.infer<typeof DocumentSchema>;

export const UpsertDocumentInputSchema = z.object({
  path: z.string().min(1).max(1024),
  title: z.string().max(500),
  content: z.string().max(2_000_000),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteCount: z.number().int().nonnegative().max(2_000_000),
  expectedVersion: z.number().int().nonnegative().nullable().default(null),
  origin: z.enum(["obsidian", "drive_import"]).default("obsidian"),
});
export type UpsertDocumentInput = z.infer<typeof UpsertDocumentInputSchema>;

export const BatchUpsertInputSchema = z.object({
  documents: z.array(UpsertDocumentInputSchema).min(1).max(50),
});

export const ProposePatchInputSchema = z.object({
  targetPath: z.string().min(1).max(1024),
  expectedVersion: z.number().int().positive(),
  proposedContent: z.string().max(2_000_000),
  proposedFrontmatter: z.record(z.string(), z.unknown()).nullable().default(null),
  rationale: z.string().min(1).max(10_000),
  agent: z.enum(["chatgpt", "claude"]),
});
export type ProposePatchInput = z.infer<typeof ProposePatchInputSchema>;

export const RecordTurnSummaryInputSchema = z.object({
  agent: z.enum(["chatgpt", "claude"]),
  seenSequence: z.number().int().nonnegative(),
  summary: z.string().min(1).max(30_000),
  affectedPaths: z.array(z.string().max(1024)).max(100).default([]),
});

export const ApprovalInputSchema = z.object({
  proposalId: z.uuid(),
  instruction: z.string().min(1).max(2_000),
});

export const RejectionInputSchema = ApprovalInputSchema.extend({
  reason: z.string().min(1).max(5_000),
});

export const SyncContextInputSchema = z.object({
  agent: z.enum(["chatgpt", "claude"]),
  query: z.string().max(1_000).default(""),
  focusPaths: z.array(z.string().max(1024)).max(50).default([]),
  maxChars: z.number().int().min(1_000).max(100_000).default(30_000),
});

export const SearchInputSchema = z.object({
  query: z.string().min(1).max(1_000),
  limit: z.number().int().min(1).max(50).default(10),
});

export const EventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  kind: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actor: AgentSchema,
  origin: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export function toCamelDocument(row: Record<string, unknown>): CanonicalDocument {
  return DocumentSchema.parse({
    id: row.id,
    path: row.path,
    title: row.title,
    content: row.content,
    frontmatter: row.frontmatter,
    sha256: row.sha256,
    byteCount: row.byte_count,
    version: row.version,
    origin: row.origin,
    deleted: row.deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
