import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";

export const annotateCommandSchema = T.Object({
  name: T.Literal("annotate"),
  parameters: T.Object({
    commentUrl: T.Optional(T.String()),
    scope: T.Optional(T.Union([T.Literal("global"), T.Literal("org"), T.Literal("repo")])),
  }),
});

export const recommendationCommandSchema = T.Object({
  name: T.Literal("recommendation"),
  parameters: T.Object({
    users: T.Optional(T.Union([T.Array(T.String()), T.String()])),
  }),
});

export const commandSchema = T.Union([annotateCommandSchema, recommendationCommandSchema]);

export type Command = StaticDecode<typeof commandSchema>;
