import { describe, expect, it } from "vitest";
import { MemoryError, validateSlug } from "../src/memory";

describe("Slug Validation", () => {
  it("accepts valid slugs", () => {
    expect(validateSlug("my-user")).toBe("my-user");
    expect(validateSlug("user123")).toBe("user123");
    expect(validateSlug("alice-bob-123")).toBe("alice-bob-123");
  });

  it("normalizes slugs to lowercase", () => {
    expect(validateSlug("MyUser")).toBe("myuser");
    expect(validateSlug("ALICE")).toBe("alice");
  });

  it("removes invalid characters", () => {
    expect(validateSlug("my user")).toBe("myuser");
    expect(validateSlug("user@domain")).toBe("userdomain");
    expect(validateSlug("alice.bob")).toBe("alicebob");
  });

  it("trims leading/trailing dashes", () => {
    expect(validateSlug("-user-")).toBe("user");
    expect(validateSlug("--alice--")).toBe("alice");
  });

  it("rejects reserved slugs", () => {
    expect(() => validateSlug("app")).toThrow(MemoryError);
    expect(() => validateSlug("api")).toThrow(MemoryError);
    expect(() => validateSlug("mcp")).toThrow(MemoryError);
    expect(() => validateSlug("admin")).toThrow(MemoryError);
  });

  it("rejects empty/null slugs", () => {
    expect(validateSlug("")).toBeNull();
    expect(validateSlug(null)).toBeNull();
    expect(validateSlug(undefined)).toBeNull();
  });

  it("rejects slugs that become empty after normalization", () => {
    expect(() => validateSlug("---")).toThrow(MemoryError);
    expect(() => validateSlug("@@@")).toThrow(MemoryError);
  });
});
