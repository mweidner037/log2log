import * as z from "zod";

/**
 * JSON-serializable form of a key-value store state.
 *
 * Maps type -> array of saved values for that type.
 */
export type SavedState = Record<string, object[]>;

/**
 * Zod schema for SavedState.
 */
export const zSavedState: z.ZodType<SavedState> = z.record(
  z.string(),
  z.array(z.any())
);
