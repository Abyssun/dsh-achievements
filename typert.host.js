/**
 * dsh-achievements — Typert Host manifest.
 *
 * 手写的 TYPERT manifest（typert-loader 从包的 `./typert` 导出读取它）。
 * 它描述 Host 半发布的 `achievements` Remote 服务，浏览器半通过
 * `ctx.remote.achievements.getMetrics()` 调用。
 *
 * ⚠️ 必须与另外两处保持逐字一致：
 *   - `index.js`：类名 `AchievementsService`、服务键 `achievements`、方法名
 *   - `client.js`：`CLIENT_REMOTE` 描述符的 id / service / namespace / method
 *
 * ⚠️ 每个 `mode: "strict"` 的 codec **必须带 `create()` 工厂**：
 *   typert-loader 的 requireStrictCodec 会强制 `typeSymbol` 非空 +
 *   `typeof create === "function"`，缺一个**整个 manifest 拒载**（参考实现
 *   v1.5.0 / v1.5.2 各栽过一次）。改完必须跑 `npm run smoke:typert`。
 *
 * ⚠️ result schema 是 strict 的：`index.js` 的返回值必须与这里**逐字段对应**
 *   （字段不缺席、类型正确），否则网关校验失败。改返回值就要同步改这里。
 */

import { z } from "zod";

// ---- 信封 ----------------------------------------------------------------

const failureSchema = z
  .object({
    code: z.string().readonly(),
    message: z.string().readonly(),
  })
  .readonly();

const createFailureSchema = () => failureSchema;

// ---- getMetrics ----------------------------------------------------------

const identitySchema = z
  .object({
    anonymousUserId: z.union([z.string(), z.null()]),
    nickname: z.union([z.string(), z.null()]),
    /** 用户自己设的头像：http(s) URL 或 data:image/...（null 时客户端回退到 DSH 账号头像） */
    avatar: z.union([z.string(), z.null()]),
  })
  .readonly();

const cardsSchema = z
  .object({
    cumulativeTokens: z.number(),
    peakDayTokens: z.number(),
    peakDay: z.union([z.string(), z.null()]),
    longestTaskMs: z.number(),
    longestStreak: z.number(),
    currentStreak: z.number(),
  })
  .readonly();

const detailsSchema = z
  .object({
    sessions: z.number(),
    messages: z.number(),
    steps: z.number(),
    activeDays: z.number(),
    peakHour: z.union([z.number(), z.null()]),
    favoriteModel: z.union([z.string(), z.null()]),
  })
  .readonly();

const totalsSchema = z
  .object({
    total: z.number(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  })
  .readonly();

const daySchema = z
  .object({
    date: z.string(),
    total: z.number(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    messages: z.number(),
  })
  .readonly();

const modelSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    provider: z.string(),
    total: z.number(),
  })
  .readonly();

const metaSchema = z
  .object({
    gapMs: z.number(),
    stateVersion: z.number(),
    registryAvailable: z.boolean(),
    listing: z.number(),
    cold: z.number(),
    live: z.number(),
    failed: z.number(),
    timedOut: z.number(),
    snapshotMs: z.number(),
    backfillMs: z.number(),
  })
  .readonly();

const metricsValueSchema = z
  .object({
    ready: z.boolean(),
    collecting: z.boolean(),
    progress: z
      .object({
        done: z.number(),
        total: z.number(),
        failed: z.number(),
      })
      .readonly(),
    error: z.union([z.string(), z.null()]),
    generatedAt: z.number(),
    identity: identitySchema,
    cards: cardsSchema,
    details: detailsSchema,
    totals: totalsSchema,
    days: z.array(daySchema).readonly(),
    models: z.array(modelSchema).readonly(),
    meta: metaSchema,
  })
  .readonly();

const metricsResultSchema = z.union([
  z.object({ ok: z.literal(true).readonly(), value: metricsValueSchema }).readonly(),
  z.object({ ok: z.literal(false).readonly(), error: failureSchema }).readonly(),
]);

const createMetricsResult = () => metricsResultSchema;

// ---- setProfile ----------------------------------------------------------

const profileInputSchema = z
  .object({
    nickname: z.union([z.string(), z.null()]).optional(),
    avatar: z.union([z.string(), z.null()]).optional(),
  })
  .readonly();

const profileValueSchema = z
  .object({
    saved: z.boolean(),
    nickname: z.union([z.string(), z.null()]),
    avatar: z.union([z.string(), z.null()]),
  })
  .readonly();

const profileResultSchema = z.union([
  z.object({ ok: z.literal(true).readonly(), value: profileValueSchema }).readonly(),
  z.object({ ok: z.literal(false).readonly(), error: failureSchema }).readonly(),
]);

const createProfileResult = () => profileResultSchema;

const createProfileInput = () => profileInputSchema;

// ---- manifest ------------------------------------------------------------

export const TYPERT = {
  package: "dsh-achievements",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-achievements#achievements/getMetrics",
      service: "achievements",
      namespace: "achievements",
      method: "getMetrics",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "dsh-achievements#MetricsResult",
        schema: metricsResultSchema,
        create: createMetricsResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
    {
      id: "dsh-achievements#achievements/setProfile",
      service: "achievements",
      namespace: "achievements",
      method: "setProfile",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-achievements#achievements/setProfile:input",
            schema: profileInputSchema,
            create: createProfileInput,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "dsh-achievements#ProfileResult",
        schema: profileResultSchema,
        create: createProfileResult,
      },
      sourceLocation: { file: "index.js", line: 1, column: 1 },
    },
  ],
  model: {
    services: [
      {
        description:
          "Personal achievements service: cross-session token totals, peak usage, longest task, streaks and the per-day/per-model breakdown for the DeepSeek Harness web UI.",
        summary: "Personal token achievements service.",
        tags: [],
        jsDoc: "/**\n * Personal achievements: cross-session token aggregates and streaks.\n */",
        key: "achievements",
        exportName: "AchievementsService",
        members: [
          {
            kind: "method",
            name: "getMetrics",
            signature: "@Remote('getMetrics') async getMetrics(): Promise<MetricsResult>",
            summary:
              "Return the whole-history snapshot: 5 profile cards, overview metrics, per-day and per-model breakdown.",
            jsDoc:
              "/**\n * Aggregate every session's ledger (live sessions through the official\n * session-projection registry, cold ones from a cached log fold) into the\n * profile cards and dashboard metrics.\n * @returns success with the snapshot, or a business failure.\n */",
          },
          {
            kind: "method",
            name: "setProfile",
            signature:
              "@Remote('setProfile') async setProfile(input: ProfileInput): Promise<ProfileResult>",
            summary: "Persist the display nickname / avatar URL for the profile page.",
            jsDoc:
              "/**\n * Save the profile page's display identity to this plugin's own config file.\n * @param input - partial patch; null clears a field.\n * @returns success with the stored values, or a business failure.\n */",
          },
        ],
        types: [
          {
            name: "MetricsValue",
            declaration:
              "export interface MetricsValue {\n    readonly ready: boolean;\n    readonly error: string | null;\n    readonly generatedAt: number;\n    readonly identity: { readonly anonymousUserId: string | null; readonly nickname: string | null; readonly avatarUrl: string | null };\n    readonly cards: { readonly cumulativeTokens: number; readonly peakDayTokens: number; readonly peakDay: string | null; readonly longestTaskMs: number; readonly longestStreak: number; readonly currentStreak: number };\n    readonly details: { readonly sessions: number; readonly messages: number; readonly steps: number; readonly activeDays: number; readonly peakHour: number | null; readonly favoriteModel: string | null };\n    readonly totals: { readonly total: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };\n    readonly days: readonly { readonly date: string; readonly total: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly messages: number }[];\n    readonly models: readonly { readonly key: string; readonly name: string; readonly provider: string; readonly total: number }[];\n    readonly meta: { readonly gapMs: number; readonly stateVersion: number; readonly listing: number; readonly liveFromRegistry: number; readonly liveFallback: number; readonly coldFromLog: number; readonly failed: number; readonly registryAvailable: boolean };\n}",
          },
          {
            name: "MetricsResult",
            declaration:
              "export type MetricsResult = { ok: true; value: MetricsValue } | { ok: false; error: { code: string; message: string } };",
          },
          {
            name: "ProfileInput",
            declaration:
              "export interface ProfileInput {\n    readonly nickname?: string | null;\n    readonly avatarUrl?: string | null;\n}",
          },
          {
            name: "ProfileValue",
            declaration:
              "export interface ProfileValue {\n    readonly saved: boolean;\n    readonly nickname: string | null;\n    readonly avatarUrl: string | null;\n}",
          },
          {
            name: "ProfileResult",
            declaration:
              "export type ProfileResult = { ok: true; value: ProfileValue } | { ok: false; error: { code: string; message: string } };",
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
};
