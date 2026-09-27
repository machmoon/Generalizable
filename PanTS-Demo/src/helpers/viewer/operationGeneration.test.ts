import { describe, expect, it } from "vitest";
import { createOperationGeneration } from "./operationGeneration";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createOperationGeneration", () => {
  it("rejects a deferred operation after it is invalidated", async () => {
    const operations = createOperationGeneration("operation disabled");
    const generation = operations.begin();
    const pending = deferred();
    const operation = (async () => {
      await pending.promise;
      operations.throwIfStale(generation);
    })();

    operations.invalidate();
    pending.resolve();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the newest operation valid while invalidating its predecessor", () => {
    const operations = createOperationGeneration("operation replaced");
    const first = operations.begin();
    const second = operations.begin();

    expect(() => operations.throwIfStale(first)).toThrowError(DOMException);
    expect(() => operations.throwIfStale(second)).not.toThrow();
  });
});
