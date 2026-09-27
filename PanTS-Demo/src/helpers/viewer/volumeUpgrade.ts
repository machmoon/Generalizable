type RollbackVolumeUpgradeOptions = {
  swappedToNewVolume: boolean;
  previousVolumeId: string | null;
  restorePreviousVolume: (volumeId: string) => Promise<void>;
  releaseNewVolume: () => void;
};

export async function rollbackVolumeUpgrade({
  swappedToNewVolume,
  previousVolumeId,
  restorePreviousVolume,
  releaseNewVolume,
}: RollbackVolumeUpgradeOptions): Promise<boolean> {
  if (swappedToNewVolume) {
    if (!previousVolumeId) return false;
    try {
      await restorePreviousVolume(previousVolumeId);
    } catch {
      return false;
    }
  }

  releaseNewVolume();
  return true;
}
