import { describe, it, expect } from "vitest";
import { z } from "zod";

describe("toolchain", () => {
  it("runs vitest and zod", () => {
    const schema = z.object({ id: z.string().min(1) });
    expect(schema.safeParse({ id: "P01" }).success).toBe(true);
    expect(schema.safeParse({ id: "" }).success).toBe(false);
  });
});