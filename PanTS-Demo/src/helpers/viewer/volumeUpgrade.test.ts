import { describe, expect, it, vi } from "vitest";
import { rollbackVolumeUpgrade } from "./volumeUpgrade";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("rollbackVolumeUpgrade", () => {
  it("restores the previous volume before releasing a swapped HD volume", async () => {
    const restoration = deferred();
    const restorePreviousVolume = vi.fn(() => restoration.promise);
    const releaseNewVolume = vi.fn();

    const rollback = rollbackVolumeUpgrade({
      swappedToNewVolume: true,
      previousVolumeId: "ct-low-res",
      restorePreviousVolume,
      releaseNewVolume,
    });

    await vi.waitFor(() => expect(restorePreviousVolume).toHaveBeenCalledWith("ct-low-res"));
    expect(releaseNewVolume).not.toHaveBeenCalled();

    restoration.resolve();

    await expect(rollback).resolves.toBe(true);
    expect(releaseNewVolume).toHaveBeenCalledOnce();
  });

  it("keeps the HD volume owned when restoring the previous volume fails", async () => {
    const releaseNewVolume = vi.fn();

    await expect(rollbackVolumeUpgrade({
      swappedToNewVolume: true,
      previousVolumeId: "ct-low-res",
      restorePreviousVolume: vi.fn().mockRejectedValue(new Error("viewport unavailable")),
      releaseNewVolume,
    })).resolves.toBe(false);

    expect(releaseNewVolume).not.toHaveBeenCalled();
  });
});
