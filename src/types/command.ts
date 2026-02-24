import { StaticDecode, Type as T } from "@sinclair/typebox";

const annotateCommandSchema = T.Object({
  name: T.Literal("annotate", { description: "Annotate an issue or pull request with vector metadata.", examples: ["/annotate"] }),
  parameters: T.Object({
    commentUrl: T.Optional(
      T.String({ description: "Comment URL to use as annotation source.", examples: ["https://github.com/owner/repo/issues/1#issuecomment-1"] })
    ),
    scope: T.Optional(
      T.Union([T.Literal("global"), T.Literal("org"), T.Literal("repo")], { description: "Scope where the annotation applies.", examples: ["repo"] })
    ),
  }),
});

export const commandSchema = annotateCommandSchema;

export type Command = StaticDecode<typeof commandSchema>;
