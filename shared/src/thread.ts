import { z } from "zod";

/** 時刻はISO 8601(UTC, 末尾Z)の文字列。 */
export const IsoUtcSchema = z.iso.datetime();

export const CommentSchema = z.object({
  id: z.string(),
  role: z.enum(["root", "reply"]),
  createdAt: IsoUtcSchema,
  author: z.string().nullable(),
  authorKind: z.enum(["human", "bot", "unknown"]),
  /** PRが見つからない/authorが不明ならnull */
  isPrAuthor: z.boolean().nullable(),
  body: z.string(),
  /** html_url(コメントへのリンク) */
  url: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const ExcludedReasonSchema = z.enum(["bot-root", "unknown-root", "parent-missing"]);
export type ExcludedReason = z.infer<typeof ExcludedReasonSchema>;

export const ThreadSchema = z.object({
  schemaVersion: z.literal(1),
  /** 親コメントのid */
  threadId: z.string(),
  repo: z.string(),
  pr: z
    .object({
      number: z.number().int(),
      url: z.string(),
      title: z.string(),
      authorLogin: z.string().nullable(),
    })
    .nullable(),
  path: z.string(),
  diffHunk: z.string(),
  /** createdAt昇順、同時刻はid昇順 */
  comments: z.array(CommentSchema),
  excludedReason: ExcludedReasonSchema.nullable(),
});
export type Thread = z.infer<typeof ThreadSchema>;
