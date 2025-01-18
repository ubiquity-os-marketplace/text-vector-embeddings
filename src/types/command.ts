import { Type as T } from "@sinclair/typebox";
import { StaticDecode } from "@sinclair/typebox";

export const annotateCommandSchema = T.Object({
  name: T.Literal("annotate"),
  parameters: T.Object({
    commentUrl: T.String(),
    scope: T.String(),
  }),
});

export type Command = StaticDecode<typeof annotateCommandSchema>;
