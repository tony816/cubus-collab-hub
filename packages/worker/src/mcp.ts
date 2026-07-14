import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { AppEnv, OAuthProps } from "./env.js";
import { CollabService } from "./service.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export class CubusMCP extends McpAgent<AppEnv, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "CUBUS Collaboration Hub", version: "0.1.0" });

  init(): Promise<void> {
    const props = this.props;
    if (!props || props.login !== this.env.ALLOWED_GITHUB_LOGIN) {
      throw new Error("GitHub account is not allowed");
    }
    const service = new CollabService(this.env);

    this.server.registerTool("sync_context", {
      description: "Read canonical documents, changes since this agent's cursor, pending proposals, conflicts, and the other AI's recent verbatim turns (recentTurns: agent, createdAt, userPrompt, responseText) before responding. latestSequence is the global newest event.",
      inputSchema: {
        agent: z.enum(["chatgpt", "claude"]),
        query: z.string().max(1000).default(""),
        focusPaths: z.array(z.string().max(1024)).max(50).default([]),
        maxChars: z.number().int().min(1000).max(100000).default(30000),
      },
      annotations: { readOnlyHint: true },
    }, async (input) => textResult(await service.syncContext(input)));

    this.server.registerTool("get_document", {
      description: "Read one canonical document by its vault-relative path.",
      inputSchema: { path: z.string().min(1).max(1024) },
      annotations: { readOnlyHint: true },
    }, async ({ path }) => textResult(await service.getDocument(path)));

    this.server.registerTool("search_canon", {
      description: "Search Korean or English text in canonical document titles and bodies.",
      inputSchema: { query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true },
    }, async ({ query, limit }) => textResult(await service.search(query, limit)));

    this.server.registerTool("list_proposals", {
      description: "List document change proposals. Omit status to list all statuses.",
      inputSchema: { status: z.enum(["pending", "approved", "rejected", "conflict"]).optional() },
      annotations: { readOnlyHint: true },
    }, async ({ status }) => textResult(await service.listProposals(status)));

    this.server.registerTool("propose_patch", {
      description: "Create a pending AI proposal. This never changes the canonical document.",
      inputSchema: {
        targetPath: z.string().min(1).max(1024),
        expectedVersion: z.number().int().positive(),
        proposedContent: z.string().max(2_000_000),
        proposedFrontmatter: z.record(z.string(), z.unknown()).nullable().default(null),
        rationale: z.string().min(1).max(10_000),
        agent: z.enum(["chatgpt", "claude"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async (input) => textResult(await service.propose(input)));

    this.server.registerTool("record_turn_summary", {
      description: "After a successful response, log this turn so the other AI can read it verbatim, and advance this agent's cursor. Provide userPrompt (the user's exact prompt, verbatim) and responseText (your exact full reply, verbatim — do NOT summarize or shorten). summary is an optional one-line scan hint. Text over 100,000 chars is truncated on the server.",
      inputSchema: {
        agent: z.enum(["chatgpt", "claude"]),
        seenSequence: z.number().int().nonnegative(),
        userPrompt: z.string().min(1).max(500_000),
        responseText: z.string().min(1).max(500_000),
        summary: z.string().max(30_000).optional(),
        affectedPaths: z.array(z.string().max(1024)).max(100).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async (input) => textResult(await service.recordTurn(input)));

    this.server.registerTool("approve_proposal", {
      description: "Approve a pending proposal only after the user explicitly instructs approval in the current conversation.",
      inputSchema: { proposalId: z.uuid(), instruction: z.string().min(1).max(2000) },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ proposalId, instruction }) => textResult(await service.approve(proposalId, instruction)));

    this.server.registerTool("reject_proposal", {
      description: "Reject a pending proposal only after the user explicitly instructs rejection.",
      inputSchema: {
        proposalId: z.uuid(),
        instruction: z.string().min(1).max(2000),
        reason: z.string().min(1).max(5000),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ proposalId, instruction, reason }) => textResult(await service.reject(proposalId, instruction, reason)));

    return Promise.resolve();
  }
}
