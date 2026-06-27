import * as z from "zod";

/**
 * A saved state maps type -> array of serialized values for that type.
 */
export type SavedState = Record<string, object[]>;

export const zSavedState: z.ZodType<SavedState> = z.record(
  z.string(),
  z.array(z.any())
);
