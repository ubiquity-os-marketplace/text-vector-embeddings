import { StaticDecode, Type as T } from "@sinclair/typebox";

const annotateCommandSchema = T.Object({
  name: T.Literal("annotate"),
  parameters: T.Object({
    commentUrl: T.Optional(T.String()),
    scope: T.Optional(T.Union([T.Literal("global"), T.Literal("org"), T.Literal("repo")])),
  }),
});

export const commandSchema = annotateCommandSchema;

export type Command = StaticDecode<typeof commandSchema>;
